import { afterEach, describe, it, expect, vi } from "vitest";
import {
  LiveKernelHost,
  type BootDescriptor,
  type FileSystemLike,
  type KernelLike,
  type LazyDownloadEvent,
  type MachineStatus,
  type ProcessEvent,
  type TerminalSessionPolicy,
} from "../src/kernel-host";
import {
  genericDemoPresentation,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  resolveDemoAssets,
  resolveDemoGuide,
  resolveDemoPresentation,
  validateKandeloDemoConfig,
} from "../src/demo-config";
import { readKandeloDemoConfigFromVfs } from "../src/demo-config-vfs";
import {
  DOOM_COMMAND,
  builtinDemoAssets,
  builtinDemoGuide,
  builtinDemoPresentation,
  nodeGuide,
} from "../src/demo-guides";
import {
  experimentalTerminalSessionPolicy,
  parseExperimentalTerminalSession,
} from "../src/experimental-terminal-session";
import {
  MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
  SHELL_DERIVED_VFS_MIN_FREE_BYTES,
  SHELL_DERIVED_VFS_MIN_FREE_INODES,
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
  assertVfsImageFitsProfile,
} from "../src/vfs-capacity";
import {
  decodeBootDescriptor,
  encodeBootDescriptor,
  HARD_CAPS,
  validateBootDescriptor,
} from "../src/boot-descriptor";

/**
 * Vitest coverage for the kandelo-session kernel-host surface:
 *
 *   1. LiveKernelHost — status, dmesg, process events, descriptor
 *      cloning, lifecycle hooks, and gallery defaults.
 *
 * Things explicitly NOT covered here (see
 * docs/plans/2026-05-14-kandelo-ui-followups.md): boot-descriptor
 * encode/decode round-trip, snapshot mode-picker
 * boundaries, React hook tests, browser-side PTY/framebuffer/focus.
 */

const DUMMY_DESCRIPTOR: BootDescriptor = {
  version: 1,
  id: "test",
  title: "Test machine",
  base: "kandelo:shell@abi8",
  runtime: {
    arch: "wasm32",
    kernel: "kernel@sha256:0123456789abcdef",
    memoryPages: 1024,
    features: ["pty"],
    time: "real",
  },
  packages: [],
  mounts: [
    { path: "/", source: "image", ref: "rootfs@sha256:abc123", readonly: true },
    { path: "/tmp", source: "scratch", ephemeral: true },
  ],
  boot: { argv: ["/bin/sh"], cwd: "/", env: { HOME: "/" } },
};

const INLINE_OVERLAY_DESCRIPTOR: BootDescriptor = {
  ...DUMMY_DESCRIPTOR,
  id: "delta",
  mounts: [
    ...DUMMY_DESCRIPTOR.mounts,
    { path: "/home/user", source: "inline-overlay", data: "abc123" },
  ],
};

function packageLayerMount(name = "python") {
  const digestDigit = name === "python" ? "1" : "2";
  return {
    path: "/" as const,
    source: "package-layer" as const,
    name,
    url: `https://example.invalid/${name}.json`,
    ref: `sha256:${digestDigit.repeat(64)}`,
    bytes: 1024,
  };
}

describe("BootDescriptor: package-layer validation", () => {
  it("accepts a bounded immutable package-layer above the root image", () => {
    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [...DUMMY_DESCRIPTOR.mounts, packageLayerMount()],
    })).not.toThrow();
  });

  it("preserves the complete immutable package-layer identity in a URL round trip", async () => {
    const descriptor: BootDescriptor = {
      ...DUMMY_DESCRIPTOR,
      mounts: [...DUMMY_DESCRIPTOR.mounts, packageLayerMount()],
    };
    const encoded = await encodeBootDescriptor(descriptor);
    await expect(decodeBootDescriptor(encoded.fragment)).resolves.toEqual(descriptor);
  });

  it.each([
    "relative",
    "/home/../etc",
    "/home//user",
    "/home/user/",
    "/home\\user",
    "/home/\0user",
  ])("rejects malformed mount path %j", (path) => {
    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [{ path, source: "scratch" }],
    })).toThrow(/canonical absolute POSIX path/);
  });

  it("enforces both total mount and package-layer caps", () => {
    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: Array.from(
        { length: HARD_CAPS.maxMounts + 1 },
        (_, index) => ({ path: `/m${index}`, source: "scratch" }),
      ),
    })).toThrow(/mount count .* exceeds cap/);

    const layers = Array.from(
      { length: HARD_CAPS.maxPackageLayers + 1 },
      (_, index) => ({
        ...packageLayerMount(`layer-${index}`),
        url: `https://example.invalid/layer-${index}.json`,
        ref: `sha256:${index.toString(16).padStart(64, "0")}`,
      }),
    );
    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [DUMMY_DESCRIPTOR.mounts[0], ...layers],
    })).toThrow(/package-layer count exceeds cap/);

    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [
        DUMMY_DESCRIPTOR.mounts[0],
        {
          ...packageLayerMount("python"),
          bytes: Math.floor(HARD_CAPS.maxPackageLayerDescriptorBytes / 2) + 1,
        },
        {
          ...packageLayerMount("perl"),
          url: "https://example.invalid/perl.json",
          ref: `sha256:${"2".repeat(64)}`,
          bytes: Math.floor(HARD_CAPS.maxPackageLayerDescriptorBytes / 2) + 1,
        },
      ],
    })).toThrow(/aggregate cap/);
  });

  it("requires a bounded hashed HTTPS descriptor and root-only layer path", () => {
    for (const [patch, error] of [
      [{ path: "/opt" }, /require path \//],
      [{ url: "http://example.invalid/python.json" }, /HTTPS URL/],
      [{ ref: `sha256:${"A".repeat(64)}` }, /lowercase sha256/],
      [{ bytes: HARD_CAPS.maxPackageLayerDescriptorBytes + 1 }, /bytes must be between/],
    ] as const) {
      expect(() => validateBootDescriptor({
        ...DUMMY_DESCRIPTOR,
        mounts: [
          DUMMY_DESCRIPTOR.mounts[0],
          { ...packageLayerMount(), ...patch },
        ],
      })).toThrow(error);
    }
  });

  it.each(["name", "ref", "url"] as const)(
    "rejects duplicate package-layer %s identities",
    (field) => {
      const second = {
        ...packageLayerMount("perl"),
        url: "https://example.invalid/perl.json",
        ref: `sha256:${"2".repeat(64)}`,
        [field]: packageLayerMount()[field],
      };
      expect(() => validateBootDescriptor({
        ...DUMMY_DESCRIPTOR,
        mounts: [DUMMY_DESCRIPTOR.mounts[0], packageLayerMount(), second],
      })).toThrow(/duplicates another layer identity/);
    },
  );

  it("rejects conflicting concrete mounts while allowing layers above the root image", () => {
    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [
        { path: "/", source: "image" },
        { path: "/", source: "scratch" },
      ],
    })).toThrow(/multiple concrete mounts target/);

    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [DUMMY_DESCRIPTOR.mounts[0], packageLayerMount()],
    })).not.toThrow();
  });

  it("requires the exact closed package-layer mount surface and a root image", () => {
    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [
        DUMMY_DESCRIPTOR.mounts[0],
        { ...packageLayerMount(), readonly: true },
      ],
    })).toThrow(/unexpected or missing fields/);

    expect(() => validateBootDescriptor({
      ...DUMMY_DESCRIPTOR,
      mounts: [packageLayerMount()],
    })).toThrow(/require a root image mount/);
  });
});

function makeFs(files: Record<string, string>): FileSystemLike {
  const encoder = new TextEncoder();
  const entries = new Map(
    Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]),
  );
  const handles = new Map<number, { data: Uint8Array; offset: number }>();
  let nextHandle = 1;

  const fs: FileSystemLike = {
    stat(path: string) {
      const data = entries.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      return { mode: 0o100644, size: data.byteLength, mtimeMs: 0, uid: 0, gid: 0 };
    },
    open(path: string) {
      const data = entries.get(path);
      if (!data) throw new Error(`ENOENT: ${path}`);
      const handle = nextHandle++;
      handles.set(handle, { data, offset: 0 });
      return handle;
    },
    read(handle: number, buffer: Uint8Array, offset: number | null, length: number) {
      const entry = handles.get(handle);
      if (!entry) throw new Error(`EBADF: ${handle}`);
      const start = offset ?? 0;
      const available = entry.data.byteLength - entry.offset;
      const n = Math.max(0, Math.min(length, available, buffer.byteLength - start));
      if (n > 0) {
        buffer.set(entry.data.subarray(entry.offset, entry.offset + n), start);
        entry.offset += n;
      }
      return n;
    },
    close(handle: number) {
      handles.delete(handle);
      return 0;
    },
    readlink(path: string) {
      throw new Error(`EINVAL: ${path}`);
    },
    opendir(path: string) {
      throw new Error(`ENOTDIR: ${path}`);
    },
    readdir() {
      return null;
    },
    closedir() {},
  };
  return fs;
}

// ── LiveKernelHost ─────────────────────────────────────────────────────

describe("LiveKernelHost: status", () => {
  it("returns the initial status from the constructor option", () => {
    const host = new LiveKernelHost({ status: "running" });
    expect(host.getStatus()).toBe("running");
  });

  it("defaults to 'idle' when no status is provided", () => {
    const host = new LiveKernelHost();
    expect(host.getStatus()).toBe("idle");
  });

  it("fires subscribers on setStatus and returns an unsubscribe", () => {
    const host = new LiveKernelHost({ status: "idle" });
    const seen: MachineStatus[] = [];
    const off = host.subscribeStatus((s) => seen.push(s));
    host.setStatus("booting");
    host.setStatus("running");
    off();
    host.setStatus("halted");
    expect(seen).toEqual(["booting", "running"]);
  });

  it("does NOT fire when setStatus is called with the current value", () => {
    const host = new LiveKernelHost({ status: "running" });
    const cb = vi.fn();
    host.subscribeStatus(cb);
    host.setStatus("running");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("LiveKernelHost: dmesg ring", () => {
  it("collects pushed lines into history", () => {
    const host = new LiveKernelHost();
    host.pushDmesg({ t: 0, level: "info", facility: "kernel", msg: "first" });
    host.pushDmesg({ t: 12, level: "warn", facility: "init", msg: "second" });
    const hist = host.dmesgHistory();
    expect(hist).toHaveLength(2);
    expect(hist[0].msg).toBe("first");
    expect(hist[1].level).toBe("warn");
  });

  it("fires subscribers on each pushed line and returns an unsubscribe", () => {
    const host = new LiveKernelHost();
    const seen: string[] = [];
    const off = host.subscribeDmesg((l) => seen.push(l.msg));
    host.pushDmesg({ t: 0, level: "info", facility: "k", msg: "a" });
    host.pushDmesg({ t: 1, level: "info", facility: "k", msg: "b" });
    off();
    host.pushDmesg({ t: 2, level: "info", facility: "k", msg: "c" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("history is a snapshot — mutating the returned array doesn't affect the ring", () => {
    const host = new LiveKernelHost();
    host.pushDmesg({ t: 0, level: "info", facility: "k", msg: "a" });
    const snap = host.dmesgHistory();
    snap.push({ t: 9, level: "err", facility: "k", msg: "fake" });
    expect(host.dmesgHistory()).toHaveLength(1);
  });
});

describe("LiveKernelHost: process events", () => {
  it("fans out emitProcessEvent to subscribers in order", () => {
    const host = new LiveKernelHost();
    const eventsA: ProcessEvent[] = [];
    const eventsB: ProcessEvent[] = [];
    host.subscribeProcessEvents((e) => eventsA.push(e));
    host.subscribeProcessEvents((e) => eventsB.push(e));
    host.emitProcessEvent({ kind: "spawn", pid: 42 });
    host.emitProcessEvent({ kind: "exit", pid: 42, exitStatus: 0 });
    expect(eventsA).toEqual([
      { kind: "spawn", pid: 42 },
      { kind: "exit", pid: 42, exitStatus: 0 },
    ]);
    expect(eventsB).toEqual(eventsA);
  });

  it("subscribe returns an unsubscribe that detaches that listener only", () => {
    const host = new LiveKernelHost();
    const a = vi.fn();
    const b = vi.fn();
    const offA = host.subscribeProcessEvents(a);
    host.subscribeProcessEvents(b);
    offA();
    host.emitProcessEvent({ kind: "spawn", pid: 100 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });
});

describe("LiveKernelHost: terminal sharing", () => {
  function seedPtySession(host: LiveKernelHost, path: string, pid: number) {
    const listeners = new Set<(bytes: Uint8Array) => void>();
    const session = {
      path,
      pid,
      logicalGeneration: 0,
      processGeneration: 0,
      restartTimer: null,
      removed: false,
      closed: false,
      cols: 100,
      rows: 30,
      history: [new TextEncoder().encode("kandelo:~$ ")],
      dataListeners: {
        add: (cb: (bytes: Uint8Array) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
    };
    (host as any).ptySessions.set(path, session);
    (host as any).emitTerminalSessions();
    return {
      emit: (text: string) => {
        const bytes = new TextEncoder().encode(text);
        for (const cb of [...listeners]) cb(bytes);
      },
      listenerCount: () => listeners.size,
    };
  }

  function sharingHost(): { host: LiveKernelHost; ptyWrite: ReturnType<typeof vi.fn> } {
    const host = new LiveKernelHost();
    const ptyWrite = vi.fn();
    host.attachKernel({
      ptyWrite,
      terminateProcess: vi.fn(async () => {}),
    } as any);
    return { host, ptyWrite };
  }

  it("offers nothing to share until a terminal is attached", () => {
    const { host } = sharingHost();
    expect(host.getTerminalSessions()).toEqual([]);
    // A terminal nobody opened is not one to share, and the host says so
    // rather than handing back a handle onto nothing.
    expect(host.sharePty("/dev/pts/0")).toBeNull();
  });

  it("reports the terminals that exist as they come and go", () => {
    const { host } = sharingHost();
    const seen: string[][] = [];
    const off = host.subscribeTerminalSessions((paths) => seen.push(paths));
    seedPtySession(host, "/dev/pts/0", 42);
    seedPtySession(host, "/dev/pts/1", 43);
    host.removePty("/dev/pts/0");
    off();
    seedPtySession(host, "/dev/pts/2", 44);
    expect(seen).toEqual([
      ["/dev/pts/0"],
      ["/dev/pts/0", "/dev/pts/1"],
      ["/dev/pts/1"],
    ]);
  });

  it("seeds a sharer with the history and adopts the session's geometry", () => {
    const { host } = sharingHost();
    const pty = seedPtySession(host, "/dev/pts/0", 42);
    const shared = host.sharePty("/dev/pts/0")!;
    const chunks: string[] = [];
    shared.onData((bytes) => chunks.push(new TextDecoder().decode(bytes)));
    pty.emit("ls\r\n");
    expect(chunks).toEqual(["kandelo:~$ ", "ls\r\n"]);
    expect(shared.size()).toEqual({ cols: 100, rows: 30 });
  });

  it("writes a sharer's keystrokes to the session's pty", () => {
    const { host, ptyWrite } = sharingHost();
    seedPtySession(host, "/dev/pts/0", 42);
    const shared = host.sharePty("/dev/pts/0")!;
    shared.write("ls\n");
    expect(ptyWrite).toHaveBeenCalledWith(42, new TextEncoder().encode("ls\n"));
  });

  it("close detaches the sharer without disturbing the session", () => {
    const { host, ptyWrite } = sharingHost();
    const pty = seedPtySession(host, "/dev/pts/0", 42);
    const shared = host.sharePty("/dev/pts/0")!;
    shared.onData(() => {});
    expect(pty.listenerCount()).toBe(1);

    shared.close();
    expect(pty.listenerCount()).toBe(0);
    // The logical PTY outlives the sharer: closing a share must not silence
    // the terminal the machine's own user is looking at.
    expect(host.getTerminalSessions()).toEqual(["/dev/pts/0"]);
    shared.write("ls\n");
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

describe("LiveKernelHost: lazy download events", () => {
  it("fans out kernel lazy download events and records history", () => {
    let kernelCb: ((event: LazyDownloadEvent) => void) | null = null;
    const offKernel = vi.fn();
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void) {
          kernelCb = cb;
          return offKernel;
        },
      } as any,
    });
    const seen: LazyDownloadEvent[] = [];
    const summaryChanges = vi.fn();
    host.subscribeLazyDownloads((event) => seen.push(event));
    const offSummaries = host.subscribeLazyDownloadSummaries(summaryChanges);

    const event: LazyDownloadEvent = {
      id: "tree:7",
      kind: "tree",
      status: "progress",
      url: "/assets/node.wasm",
      path: "/usr/bin/node",
      loadedBytes: 512,
      totalBytes: 1024,
      t: 10,
    };
    kernelCb?.(event);

    expect(seen).toEqual([event]);
    expect(host.lazyDownloadHistory()).toEqual([event]);
    expect(host.lazyDownloadSummaries()).toEqual([{
      ...event,
      firstSeenAt: 10,
      startedAt: 10,
      eventCount: 1,
    }]);
    expect(summaryChanges).toHaveBeenCalledOnce();
    offSummaries();
    kernelCb?.({ ...event, loadedBytes: 768, t: 11 });
    expect(summaryChanges).toHaveBeenCalledOnce();
    host.detachKernel();
    expect(offKernel).toHaveBeenCalledOnce();
  });

  it("keeps one authoritative summary per asset when raw progress rolls over", () => {
    const host = new LiveKernelHost();
    const emit = (
      id: string,
      status: LazyDownloadEvent["status"],
      loadedBytes: number,
      t: number,
    ) => host.emitLazyDownloadEvent({
      id,
      kind: "tree",
      status,
      url: `https://example.test/${id}.tar.gz`,
      mountPrefix: "/",
      loadedBytes,
      totalBytes: 700,
      t,
    });

    emit("early", "started", 0, 1);
    emit("early", "complete", 700, 2);
    emit("large", "started", 0, 3);
    for (let chunk = 1; chunk <= 700; chunk++) {
      emit("large", "progress", chunk, chunk + 3);
    }
    emit("large", "complete", 700, 704);

    const history = host.lazyDownloadHistory();
    expect(history).toHaveLength(512);
    expect(history.some(({ id }) => id === "early")).toBe(false);
    expect(history.map(({ t }) => t)).toEqual(
      Array.from({ length: 512 }, (_, index) => index + 193),
    );
    expect(host.lazyDownloadSummaries()).toEqual([
      expect.objectContaining({
        id: "early",
        status: "complete",
        loadedBytes: 700,
        firstSeenAt: 1,
        startedAt: 1,
        eventCount: 2,
      }),
      expect.objectContaining({
        id: "large",
        status: "complete",
        loadedBytes: 700,
        firstSeenAt: 3,
        startedAt: 3,
        eventCount: 702,
      }),
    ]);
  });

  it("keys summary cardinality to distinct assets rather than progress event count", () => {
    const host = new LiveKernelHost();
    for (let eventIndex = 0; eventIndex < 2_000; eventIndex++) {
      const id = eventIndex % 2 === 0 ? "one" : "two";
      host.emitLazyDownloadEvent({
        id,
        kind: "file",
        status: "progress",
        url: `https://example.test/${id}.wasm`,
        path: `/usr/bin/${id}`,
        loadedBytes: eventIndex,
        t: eventIndex,
      });
    }

    const summaries = host.lazyDownloadSummaries();
    expect(summaries).toHaveLength(2);
    expect(summaries.map(({ id, eventCount }) => ({ id, eventCount }))).toEqual([
      { id: "one", eventCount: 1_000 },
      { id: "two", eventCount: 1_000 },
    ]);
  });

  it("returns defensive copies of raw events and asset summaries", () => {
    const host = new LiveKernelHost();
    const event: LazyDownloadEvent = {
      id: "tree:1",
      kind: "tree",
      status: "complete",
      url: "https://example.test/tree.tar.gz",
      mountPrefix: "/",
      loadedBytes: 1024,
      totalBytes: 1024,
      t: 10,
    };
    host.emitLazyDownloadEvent(event);

    event.status = "error";
    host.lazyDownloadHistory()[0]!.status = "error";
    host.lazyDownloadSummaries()[0]!.status = "error";
    host.lazyDownloadHistory().splice(0);
    host.lazyDownloadSummaries().splice(0);

    expect(host.lazyDownloadHistory()[0]!.status).toBe("complete");
    expect(host.lazyDownloadSummaries()[0]!.status).toBe("complete");
  });

  it("cancels an active asset even after its first event leaves raw history", () => {
    const host = new LiveKernelHost();
    const seen: LazyDownloadEvent[] = [];
    host.subscribeLazyDownloads((event) => seen.push(event));
    host.emitLazyDownloadEvent({
      id: "active",
      kind: "tree",
      status: "started",
      url: "https://example.test/active.tar.gz",
      mountPrefix: "/",
      loadedBytes: 0,
      totalBytes: 700,
      t: 1,
    });
    for (let chunk = 1; chunk <= 700; chunk++) {
      host.emitLazyDownloadEvent({
        id: "active",
        kind: "tree",
        status: "progress",
        url: "https://example.test/active.tar.gz",
        mountPrefix: "/",
        loadedBytes: chunk,
        totalBytes: 700,
        t: chunk + 1,
      });
    }

    const summaryStates: Array<Array<{ status: string; error?: string }>> = [];
    host.subscribeLazyDownloadSummaries(() => {
      summaryStates.push(host.lazyDownloadSummaries().map(({ status, error }) => ({
        status,
        error,
      })));
    });
    host.attachKernel({ fs: makeFs({ "/etc/passwd": "" }) } as any);

    expect(seen.at(-1)).toMatchObject({
      id: "active",
      status: "error",
      error: "kernel replaced",
      loadedBytes: 700,
    });
    expect(summaryStates).toEqual([
      [{ status: "error", error: "kernel replaced" }],
      [],
    ]);
    expect(host.lazyDownloadHistory()).toEqual([]);
    expect(host.lazyDownloadSummaries()).toEqual([]);
  });

  it("notifies summary consumers when a new boot clears completed history", async () => {
    let kernelCb: ((event: LazyDownloadEvent) => void) | null = null;
    const replacementKernel = { fs: makeFs({ "/etc/passwd": "" }) } as any;
    const host = new LiveKernelHost({
      descriptor: DUMMY_DESCRIPTOR,
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        subscribeLazyDownloads(cb: (event: LazyDownloadEvent) => void) {
          kernelCb = cb;
          return vi.fn();
        },
      } as any,
      applyBootDescriptor: async (_descriptor, liveHost) => {
        liveHost.attachKernel(replacementKernel);
      },
    });
    const summaryStates: string[][] = [];
    host.subscribeLazyDownloadSummaries(() => {
      summaryStates.push(host.lazyDownloadSummaries().map(({ status }) => status));
    });

    kernelCb?.({
      id: "file:7",
      kind: "file",
      status: "complete",
      url: "/assets/curl.wasm",
      path: "/usr/bin/curl",
      loadedBytes: 1024,
      totalBytes: 1024,
      t: 10,
    });
    expect(host.lazyDownloadHistory()).toHaveLength(1);
    expect(host.lazyDownloadSummaries()).toHaveLength(1);

    await host.reboot();

    expect(summaryStates).toEqual([["complete"], []]);
    expect(host.lazyDownloadHistory()).toEqual([]);
    expect(host.lazyDownloadSummaries()).toEqual([]);
  });

  it("cancels and clears an active ledger when its kernel is detached", () => {
    const host = new LiveKernelHost({
      kernel: { fs: makeFs({ "/etc/passwd": "" }) } as any,
    });
    const rawEvents: LazyDownloadEvent[] = [];
    const summaryStates: string[][] = [];
    host.subscribeLazyDownloads((event) => rawEvents.push(event));
    host.subscribeLazyDownloadSummaries(() => {
      summaryStates.push(host.lazyDownloadSummaries().map(({ status }) => status));
    });
    host.emitLazyDownloadEvent({
      id: "file:detached",
      kind: "file",
      status: "progress",
      url: "https://example.test/detached.wasm",
      path: "/usr/bin/detached",
      loadedBytes: 64,
      totalBytes: 128,
      t: 10,
    });

    host.detachKernel();

    expect(rawEvents.at(-1)).toMatchObject({
      id: "file:detached",
      status: "error",
      error: "kernel detached",
    });
    expect(summaryStates).toEqual([["progress"], ["error"], []]);
    expect(host.lazyDownloadHistory()).toEqual([]);
    expect(host.lazyDownloadSummaries()).toEqual([]);
  });

  it("retains a terminal cancellation summary when the attached kernel halts", async () => {
    const destroy = vi.fn(async () => {});
    const host = new LiveKernelHost({
      status: "running",
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        destroy,
      } as any,
    });
    host.emitLazyDownloadEvent({
      id: "archive:halted",
      kind: "archive",
      status: "started",
      url: "https://example.test/halted.zip",
      mountPrefix: "/opt/halted",
      loadedBytes: 0,
      totalBytes: 4096,
      t: 10,
    });

    await host.halt();

    expect(destroy).toHaveBeenCalledOnce();
    expect(host.lazyDownloadHistory()).toHaveLength(2);
    expect(host.lazyDownloadSummaries()).toEqual([
      expect.objectContaining({
        id: "archive:halted",
        status: "error",
        error: "kernel halted",
        firstSeenAt: 10,
        startedAt: 10,
        eventCount: 2,
      }),
    ]);
  });
});

describe("LiveKernelHost: process listing", () => {
  it("resolves process snapshot UIDs through /etc/passwd", async () => {
    const fs = makeFs({
      "/etc/passwd": [
        "root:x:0:0:root:/root:/bin/sh",
        "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin",
        "mysql:x:101:101:mysql:/var/lib/mysql:/usr/sbin/nologin",
        "",
      ].join("\n"),
    });
    const host = new LiveKernelHost({
      kernel: {
        fs,
        enumProcs: async () => [
          { pid: 100, ppid: 0, uid: 0, gid: 0, vsizeBytes: 1024, state: "S", comm: "dinit", cmdline: "/sbin/dinit" },
          { pid: 101, ppid: 100, uid: 33, gid: 33, vsizeBytes: 2048, state: "S", comm: "php-fpm", cmdline: "php-fpm: pool www" },
          { pid: 102, ppid: 100, uid: 4242, gid: 4242, vsizeBytes: 4096, state: "S", comm: "worker", cmdline: "worker" },
        ],
      } as any,
    });

    const procs = await host.enumProcs();
    expect(procs.map((p) => p.user)).toEqual(["root", "www-data", "4242"]);
  });
});

describe("LiveKernelHost: machine PCM lifecycle", () => {
  it("forwards explicit activation and state changes independently of framebuffer", async () => {
    let state: import("../src/kernel-host").MachineAudioState = "suspended";
    let emit: ((next: import("../src/kernel-host").MachineAudioState) => void) | null = null;
    const prepareAudio = vi.fn(async () => {});
    const resumeAudio = vi.fn(async () => {
      state = "running";
      emit?.(state);
    });
    const suspendAudio = vi.fn(async () => {
      state = "suspended";
      emit?.(state);
    });
    const host = new LiveKernelHost({
      kernel: {
        prepareAudio,
        resumeAudio,
        suspendAudio,
        getAudioState: () => state,
        onAudioStateChange: (cb: typeof emit) => {
          emit = cb;
          cb?.(state);
          return () => { emit = null; };
        },
      } as never,
    });
    const observed: string[] = [];
    const off = host.subscribeAudioState((next) => observed.push(next));

    await host.prepareAudio();
    await host.resumeAudio();
    expect(prepareAudio).toHaveBeenCalledOnce();
    expect(resumeAudio).toHaveBeenCalledOnce();
    expect(host.getAudioState()).toBe("running");
    await host.suspendAudio();
    expect(host.getAudioState()).toBe("suspended");
    expect(observed).toContain("running");
    expect(observed.at(-1)).toBe("suspended");

    host.detachKernel();
    expect(observed.at(-1)).toBe("unavailable");
    off();
  });

  it("retains framebuffer startAudio as a non-owning machine-audio adapter", async () => {
    let state: import("../src/kernel-host").MachineAudioState = "suspended";
    const resumeAudio = vi.fn(async () => { state = "running"; });
    const suspendAudio = vi.fn(async () => { state = "suspended"; });
    const framebuffers = {
      list: () => [],
      onChange: () => () => {},
    };
    const host = new LiveKernelHost({
      kernel: {
        framebuffers,
        getProcessMemory: () => undefined,
        resumeAudio,
        suspendAudio,
        getAudioState: () => state,
      } as never,
    });

    const framebuffer = host.attachFramebuffer({} as HTMLCanvasElement);
    const output = await framebuffer.startAudio();
    expect(output).not.toBeNull();
    expect(output!.getState()).toBe("suspended");
    await output!.resume();
    expect(resumeAudio).toHaveBeenCalledOnce();
    expect(output!.getState()).toBe("running");

    output!.close();
    expect(suspendAudio).not.toHaveBeenCalled();
    expect(output!.getState()).toBe("running");
    framebuffer.close();
  });
});

describe("LiveKernelHost: shell command queue", () => {
  it("uses the worker-returned pid for a transferred shell binary", async () => {
    const outputPids: number[] = [];
    const writePids: number[] = [];
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawn(
          _programBytes: ArrayBuffer,
          _argv: string[],
          options?: { onStarted?: (pid: number) => void | Promise<void> },
        ) {
          void options?.onStarted?.(37);
          return new Promise<number>(() => {});
        },
        onPtyOutput(pid: number) {
          outputPids.push(pid);
        },
        ptyResize() {},
        ptyWrite(pid: number) {
          writePids.push(pid);
        },
      } as any,
    });
    host.setDefaultShell({
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
    });

    const pty = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    pty.write("echo ok\n");

    expect(outputPids).toEqual([37]);
    expect(writePids).toEqual([37]);
  });

  it("starts an image-owned shell from the VFS without redundant program bytes", async () => {
    const spawnFromVfs = vi.fn(async () => ({
      pid: 41,
      exit: new Promise<number>(() => {}),
    }));
    const spawn = vi.fn();
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawn,
        spawnFromVfs,
        onPtyOutput() {},
        ptyResize() {},
        ptyWrite() {},
      } as any,
    });
    host.setDefaultShell({
      programPath: "/usr/bin/dash",
      argv: ["dash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
      uid: 1000,
      gid: 1000,
    });

    await host.attachPty("/dev/pts/0", { cols: 100, rows: 30 });

    expect(spawnFromVfs).toHaveBeenCalledWith(
      "/usr/bin/dash",
      ["dash", "-l", "-i"],
      expect.objectContaining({
        pty: true,
        cwd: "/home/maker",
        uid: 1000,
        gid: 1000,
        ptyCols: 100,
        ptyRows: 30,
      }),
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a default shell without a VFS path or fallback bytes", () => {
    const host = new LiveKernelHost();
    expect(() => host.setDefaultShell({
      argv: ["sh", "-i"],
    })).toThrow("requires programPath or programBytes");
  });

  it("reports when a VFS-only shell is used with a kernel that cannot spawn it", async () => {
    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawn: vi.fn(),
        onPtyOutput() {},
        ptyResize() {},
        ptyWrite() {},
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/sh",
      argv: ["sh", "-i"],
    });

    await expect(host.attachPty("/dev/pts/0", { cols: 80, rows: 24 }))
      .rejects.toThrow("does not support spawnFromVfs");
  });

  it("does not treat heredoc continuation prompts as command completion", async () => {
    const encoder = new TextEncoder();
    let onOutput: ((data: Uint8Array) => void) | null = null;
    let releaseFinalPrompt!: () => void;
    const finalPrompt = new Promise<void>((resolve) => {
      releaseFinalPrompt = resolve;
    });

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => ({ pid: 100, exit: new Promise<number>(() => {}) }),
        onPtyOutput(_pid: number, callback: (data: Uint8Array) => void) {
          onOutput = callback;
          callback(encoder.encode("kandelo$ "));
        },
        ptyResize() {},
        ptyWrite(_pid: number, _data: Uint8Array) {
          onOutput?.(encoder.encode("cat > /tmp/k <<'EOF'\n> echo ok\n> "));
          void finalPrompt.then(() => {
            onOutput?.(encoder.encode("EOF\nok\nkandelo$ "));
          });
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
    });

    let completed = false;
    const command = host.runShellCommand("cat > /tmp/k <<'EOF'\necho ok\nEOF");
    void command.then(() => {
      completed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseFinalPrompt();
    await command;
    expect(completed).toBe(true);
  });

  it("does not treat echoed dollar-looking input as shell readiness", async () => {
    const encoder = new TextEncoder();
    let onOutput: ((data: Uint8Array) => void) | null = null;
    let releaseFinalPrompt!: () => void;
    const finalPrompt = new Promise<void>((resolve) => {
      releaseFinalPrompt = resolve;
    });

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => ({ pid: 100, exit: new Promise<number>(() => {}) }),
        onPtyOutput(_pid: number, callback: (data: Uint8Array) => void) {
          onOutput = callback;
          callback(encoder.encode("kandelo$ "));
        },
        ptyResize() {},
        ptyWrite(_pid: number, _data: Uint8Array) {
          onOutput?.(encoder.encode("printf 'literal$ '\n"));
          void finalPrompt.then(() => {
            onOutput?.(encoder.encode("literal$ \nkandelo$ "));
          });
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
    });

    let completed = false;
    const command = host.runShellCommand("printf 'literal$ '");
    void command.then(() => {
      completed = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseFinalPrompt();
    await command;
    expect(completed).toBe(true);
  });

  it("serializes concurrent PTY attaches for the same terminal session", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const callbacks = new Map<number, (data: Uint8Array) => void>();
    const writes: Array<{ pid: number; text: string }> = [];
    let releaseSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    let spawnCalls = 0;
    const allocatedPids = [100];

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => {
          spawnCalls++;
          await spawnGate;
          const pid = allocatedPids.shift()!;
          return { pid, exit: new Promise<number>(() => {}) };
        },
        onPtyOutput(pid: number, callback: (data: Uint8Array) => void) {
          callbacks.set(pid, callback);
          callback(encoder.encode(`spawned:${pid}\nkandelo$ `));
        },
        ptyResize() {},
        ptyWrite(pid: number, data: Uint8Array) {
          const text = decoder.decode(data);
          writes.push({ pid, text });
          callbacks.get(pid)?.(encoder.encode(`${text}done\nkandelo$ `));
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
    });

    const visibleAttach = host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    await Promise.resolve();
    const guideCommand = host.runShellCommand("printf guide-visible");
    await Promise.resolve();
    expect(spawnCalls).toBe(1);

    releaseSpawn();
    const visiblePty = await visibleAttach;
    await guideCommand;

    let visibleText = "";
    visiblePty.onData((bytes) => {
      visibleText += decoder.decode(bytes);
    });
    expect(spawnCalls).toBe(1);
    expect(writes).toEqual([{ pid: 100, text: "printf guide-visible\n" }]);
    expect(visibleText).toContain("spawned:100");
    expect(visibleText).toContain("printf guide-visible");
    expect(visibleText).toContain("done");
  });

  it("respawns stale PTY sessions without disconnecting existing listeners", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const callbacks = new Map<number, (data: Uint8Array) => void>();
    const livePids = new Set<number>();
    const writes: number[] = [];
    const allocatedPids = [101, 102];

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => {
          const pid = allocatedPids.shift()!;
          livePids.add(pid);
          return { pid, exit: new Promise<number>(() => {}) };
        },
        enumProcs: async () => [
          { pid: 100, ppid: 0, uid: 0, gid: 0, vsizeBytes: 1024, state: "S", comm: "dinit", cmdline: "dinit" },
          ...Array.from(livePids).map((pid) => ({
            pid,
            ppid: 100,
            uid: 1000,
            gid: 1000,
            vsizeBytes: 1024,
            state: "S",
            comm: "bash",
            cmdline: "bash -l -i",
          })),
        ],
        onPtyOutput(pid: number, callback: (data: Uint8Array) => void) {
          callbacks.set(pid, callback);
          callback(encoder.encode(`spawned:${pid}\nkandelo$ `));
        },
        ptyResize() {},
        ptyWrite(pid: number, data: Uint8Array) {
          writes.push(pid);
          callbacks.get(pid)?.(encoder.encode(`write:${pid}:${decoder.decode(data)}kandelo$ `));
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
    });

    const firstHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    let seen = "";
    firstHandle.onData((bytes) => {
      seen += decoder.decode(bytes);
    });
    expect(seen).toContain("spawned:101");

    livePids.delete(101);
    const secondHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    secondHandle.write("echo second\n");
    expect(writes).toEqual([102]);
    expect(seen).toContain("spawned:102");
    expect(seen).toContain("write:102:echo second");

    firstHandle.write("echo first\n");
    expect(writes).toEqual([102, 102]);
    expect(seen).toContain("write:102:echo first");
  });

  it("keeps PTY listeners connected when an exited shell respawns", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const callbacks = new Map<number, (data: Uint8Array) => void>();
    const exitResolvers = new Map<number, (status: number) => void>();
    const writes: number[] = [];
    const allocatedPids = [100, 101];

    const host = new LiveKernelHost({
      kernel: {
        fs: makeFs({ "/etc/passwd": "" }),
        spawnFromVfs: async () => {
          const pid = allocatedPids.shift()!;
          const exit = new Promise<number>((resolve) => {
            exitResolvers.set(pid, resolve);
          });
          return { pid, exit };
        },
        onPtyOutput(pid: number, callback: (data: Uint8Array) => void) {
          callbacks.set(pid, callback);
          callback(encoder.encode(`spawned:${pid}\nkandelo$ `));
        },
        ptyResize() {},
        ptyWrite(pid: number, data: Uint8Array) {
          writes.push(pid);
          callbacks.get(pid)?.(encoder.encode(`write:${pid}:${decoder.decode(data)}kandelo$ `));
        },
      } as any,
    });
    host.setDefaultShell({
      programPath: "/bin/bash",
      programBytes: new ArrayBuffer(0),
      argv: ["bash", "-l", "-i"],
      env: ["PS1=kandelo$ "],
      cwd: "/home/maker",
    });

    const firstHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    let seen = "";
    firstHandle.onData((bytes) => {
      seen += decoder.decode(bytes);
    });
    expect(seen).toContain("spawned:100");

    exitResolvers.get(100)?.(0);
    await Promise.resolve();
    await Promise.resolve();

    const secondHandle = await host.attachPty("/dev/pts/0", { cols: 80, rows: 24 });
    secondHandle.write("echo after-exit\n");
    expect(writes).toEqual([101]);
    expect(seen).toContain("spawned:101");
    expect(seen).toContain("write:101:echo after-exit");

    firstHandle.write("echo old-handle\n");
    expect(writes).toEqual([101, 101]);
    expect(seen).toContain("write:101:echo old-handle");
  });
});

const LOGIN_SESSION_POLICY = {
  initial: {
    programPath: "/usr/bin/login",
    argv: ["login", "-p", "-f", "maker"],
    uid: 0,
    gid: 0,
  },
  afterExit: {
    programPath: "/usr/bin/login",
    argv: ["login", "-p"],
    uid: 0,
    gid: 0,
  },
  shortRunThresholdMs: 2_000,
  initialRestartDelayMs: 250,
  maximumRestartDelayMs: 5_000,
} satisfies TerminalSessionPolicy;

type TerminalSpawn = {
  pid: number;
  programPath: string;
  argv: string[];
  uid?: number;
  gid?: number;
};

function terminalSessionHarness(
  policy: TerminalSessionPolicy = LOGIN_SESSION_POLICY,
) {
  const encoder = new TextEncoder();
  const spawns: TerminalSpawn[] = [];
  const activePids = new Set<number>();
  const exitResolvers = new Map<number, (status: number) => void>();
  const outputCallbacks = new Map<number, (data: Uint8Array) => void>();
  const terminateProcess = vi.fn(async (pid: number, status = 0) => {
    exitResolvers.get(pid)?.(status);
  });
  let nextPid = 1;
  let nextSpawnError: Error | null = null;
  let maximumActiveProcesses = 0;

  const kernel: KernelLike = {
    spawn: vi.fn(),
    async spawnFromVfs(programPath, argv, options) {
      if (nextSpawnError) {
        const error = nextSpawnError;
        nextSpawnError = null;
        throw error;
      }
      const pid = nextPid++;
      spawns.push({
        pid,
        programPath,
        argv: argv.slice(),
        uid: options?.uid,
        gid: options?.gid,
      });
      activePids.add(pid);
      maximumActiveProcesses = Math.max(
        maximumActiveProcesses,
        activePids.size,
      );
      let settled = false;
      const exit = new Promise<number>((resolve) => {
        exitResolvers.set(pid, (status) => {
          if (settled) return;
          settled = true;
          activePids.delete(pid);
          resolve(status);
        });
      });
      return { pid, exit };
    },
    onPtyOutput(pid, callback) {
      outputCallbacks.set(pid, callback);
    },
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
    terminateProcess,
    destroy: vi.fn(async () => {}),
    enumProcs: vi.fn(async () => [999, ...activePids].map((pid) => ({
      pid,
      ppid: 0,
      uid: 0,
      gid: 0,
      vsizeBytes: 0,
      state: "R" as const,
      comm: "login",
      cmdline: "login",
    }))),
  };
  const host = new LiveKernelHost({ kernel, status: "running" });
  host.setTerminalSessionPolicy(policy);

  return {
    activePids,
    dropProcess(pid: number) {
      activePids.delete(pid);
    },
    exit(pid: number, status = 0) {
      const resolve = exitResolvers.get(pid);
      if (!resolve) throw new Error(`missing exit resolver for pid ${pid}`);
      resolve(status);
    },
    failNextSpawn(message = "exec failed") {
      nextSpawnError = new Error(message);
    },
    host,
    kernel,
    maximumActiveProcesses: () => maximumActiveProcesses,
    output(pid: number, text: string) {
      outputCallbacks.get(pid)?.(encoder.encode(text));
    },
    spawns,
    terminateProcess,
  };
}

async function settleTerminalSessionWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("LiveKernelHost: supervised terminal sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("autologins once per logical PTY and UI reattachment starts no process", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();

    const first = await harness.host.attachPty("/dev/pts/0");
    let detachedOutput = "";
    first.onData((bytes) => {
      detachedOutput += new TextDecoder().decode(bytes);
    });
    first.close();
    harness.output(1, "after detach\n");
    await harness.host.attachPty("/dev/pts/0");
    await harness.host.attachPty("/dev/pts/1");

    expect(harness.spawns.map(({ argv }) => argv)).toEqual([
      ["login", "-p", "-f", "maker"],
      ["login", "-p", "-f", "maker"],
    ]);
    expect(detachedOutput).toBe("");
    expect(harness.activePids.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends the logical terminal when afterExit is omitted", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness({
      ...LOGIN_SESSION_POLICY,
      afterExit: undefined,
    });
    await harness.host.attachPty("/dev/pts/0");

    harness.exit(1);
    await settleTerminalSessionWork();

    expect(harness.spawns).toHaveLength(1);
    expect(harness.activePids).toEqual(new Set());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses ordinary login after logout and backs short runs off to the cap", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    await harness.host.attachPty("/dev/pts/0");
    const expectedDelays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];

    for (const [index, delay] of expectedDelays.entries()) {
      harness.exit(harness.spawns.at(-1)!.pid);
      await settleTerminalSessionWork();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(harness.spawns).toHaveLength(index + 1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await settleTerminalSessionWork();
      expect(harness.spawns.at(-1)!.argv).toEqual(["login", "-p"]);
      expect(vi.getTimerCount()).toBe(0);
    }

    expect(harness.spawns[0].argv).toEqual([
      "login",
      "-p",
      "-f",
      "maker",
    ]);
    expect(harness.spawns.slice(1).every(({ argv }) =>
      argv.length === 2 && argv[0] === "login" && argv[1] === "-p"
    )).toBe(true);
    expect(harness.maximumActiveProcesses()).toBe(1);
  });

  it("resets restart delay after a process survives for two seconds", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    await harness.host.attachPty("/dev/pts/0");

    harness.exit(1);
    await settleTerminalSessionWork();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(2_000);
    harness.exit(2);
    await settleTerminalSessionWork();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.spawns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawns).toHaveLength(3);

    harness.exit(3);
    await settleTerminalSessionWork();
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.spawns).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawns).toHaveLength(4);
    expect(harness.maximumActiveProcesses()).toBe(1);
  });

  it("prints a restart failure and neither retries nor repeats autologin", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    const pty = await harness.host.attachPty("/dev/pts/0");
    let output = "";
    pty.onData((bytes) => {
      output += new TextDecoder().decode(bytes);
    });

    harness.failNextSpawn("missing /usr/bin/login");
    harness.exit(1);
    await settleTerminalSessionWork();
    await vi.advanceTimersByTimeAsync(250);
    await settleTerminalSessionWork();

    expect(output).toContain("missing /usr/bin/login");
    expect(harness.spawns).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    pty.close();
    await harness.host.attachPty("/dev/pts/0");
    expect(harness.spawns).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes initial autologin before a failed first launch", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    harness.failNextSpawn("initial login launch failed");

    await expect(harness.host.attachPty("/dev/pts/0"))
      .rejects.toThrow("initial login launch failed");
    const pty = await harness.host.attachPty("/dev/pts/0");
    let output = "";
    pty.onData((bytes) => {
      output += new TextDecoder().decode(bytes);
    });

    expect(output).toContain("initial login launch failed");
    expect(harness.spawns).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logical removal cancels restart and allocates fresh autologin state", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    await harness.host.attachPty("/dev/pts/0");
    harness.exit(1);
    await settleTerminalSessionWork();
    expect(vi.getTimerCount()).toBe(1);

    harness.host.removePty("/dev/pts/0");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await harness.host.attachPty("/dev/pts/0");

    expect(harness.spawns.map(({ argv }) => argv)).toEqual([
      ["login", "-p", "-f", "maker"],
      ["login", "-p", "-f", "maker"],
    ]);
    expect(harness.activePids).toEqual(new Set([2]));
  });

  it.each(["detach", "reboot", "halt"] as const)(
    "cancels pending restart on kernel $transition",
    async (transition) => {
      vi.useFakeTimers();
      const harness = terminalSessionHarness();
      await harness.host.attachPty("/dev/pts/0");
      harness.exit(1);
      await settleTerminalSessionWork();
      expect(vi.getTimerCount()).toBe(1);

      if (transition === "detach") harness.host.detachKernel();
      else if (transition === "reboot") await harness.host.reboot();
      else await harness.host.halt();

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.spawns).toHaveLength(1);
    },
  );

  it.each(["remove", "detach", "reboot", "destroy"] as const)(
    "terminates an active login process on $transition",
    async (transition) => {
      vi.useFakeTimers();
      const harness = terminalSessionHarness();
      await harness.host.attachPty("/dev/pts/0");
      expect(harness.activePids).toEqual(new Set([1]));

      if (transition === "remove") harness.host.removePty("/dev/pts/0");
      else if (transition === "detach") harness.host.detachKernel();
      else if (transition === "reboot") await harness.host.reboot();
      else await harness.host.halt();
      await settleTerminalSessionWork();

      expect(harness.terminateProcess).toHaveBeenCalledWith(1);
      expect(harness.activePids).toEqual(new Set());
      if (transition === "destroy") {
        expect(harness.kernel.destroy).toHaveBeenCalledOnce();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores stale exit and output callbacks after path reuse", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    const oldPty = await harness.host.attachPty("/dev/pts/0");
    let oldOutput = "";
    oldPty.onData((bytes) => {
      oldOutput += new TextDecoder().decode(bytes);
    });

    harness.host.removePty("/dev/pts/0");
    const currentPty = await harness.host.attachPty("/dev/pts/0");
    let currentOutput = "";
    currentPty.onData((bytes) => {
      currentOutput += new TextDecoder().decode(bytes);
    });
    harness.output(1, "stale\n");
    harness.exit(1);
    await settleTerminalSessionWork();

    expect(oldOutput).toBe("");
    expect(currentOutput).toBe("");
    expect(harness.spawns).toHaveLength(2);
    expect(harness.activePids).toEqual(new Set([2]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns reattach-time liveness loss into one ordinary-login restart", async () => {
    vi.useFakeTimers();
    const harness = terminalSessionHarness();
    const first = await harness.host.attachPty("/dev/pts/0");
    harness.dropProcess(1);

    first.close();
    await harness.host.attachPty("/dev/pts/0");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    await settleTerminalSessionWork();
    expect(harness.spawns.map(({ argv }) => argv)).toEqual([
      ["login", "-p", "-f", "maker"],
      ["login", "-p"],
    ]);

    harness.exit(1);
    await settleTerminalSessionWork();
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.activePids).toEqual(new Set([2]));
  });
});

describe("LiveKernelHost: descriptor", () => {
  it("getBootDescriptor returns a deep clone — callers can't mutate internal state", () => {
    const host = new LiveKernelHost({ descriptor: DUMMY_DESCRIPTOR });
    const fetched = host.getBootDescriptor();
    fetched.mounts.push({ path: "/sneaky", source: "scratch" });
    fetched.boot.argv.push("--rogue");
    const second = host.getBootDescriptor();
    expect(second.mounts).toHaveLength(DUMMY_DESCRIPTOR.mounts.length);
    expect(second.boot.argv).toEqual(["/bin/sh"]);
  });

  it("setDescriptor replaces the descriptor without firing status", () => {
    const host = new LiveKernelHost({ status: "running" });
    const cb = vi.fn();
    host.subscribeStatus(cb);
    const next: BootDescriptor = {
      ...DUMMY_DESCRIPTOR,
      id: "next",
      title: "Next machine",
    };
    host.setDescriptor(next);
    expect(host.getBootDescriptor().id).toBe("next");
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("LiveKernelHost: descriptor + gallery lifecycle defaults", () => {
  it("applyBootDescriptor stores the descriptor when no live apply hook is installed", async () => {
    const host = new LiveKernelHost();
    await host.applyBootDescriptor(DUMMY_DESCRIPTOR);
    expect(host.getBootDescriptor().id).toBe(DUMMY_DESCRIPTOR.id);
  });

  it("applyBootDescriptor delegates to the installed live apply hook", async () => {
    const applyBootDescriptor = vi.fn(async (desc: BootDescriptor, host: LiveKernelHost) => {
      host.setDescriptor(desc);
      host.setStatus("running");
    });
    const host = new LiveKernelHost({ applyBootDescriptor });
    await host.applyBootDescriptor(DUMMY_DESCRIPTOR);
    expect(applyBootDescriptor).toHaveBeenCalledOnce();
    expect(host.getStatus()).toBe("running");
  });

  it("halt sets status to halted", async () => {
    const host = new LiveKernelHost({ status: "running" });
    await host.halt();
    expect(host.getStatus()).toBe("halted");
  });

  it("galleryQuery returns installed presets and still leaves saveCurrentToGallery as a stub", async () => {
    const host = new LiveKernelHost({
      galleryItems: [{
        id: "shell",
        title: "Shell",
        summary: "Shell preset",
        base: "kandelo:shell@abi8",
        packages: [],
        bootCommand: ["/bin/sh"],
        accent: "#dc6529",
        glyph: "sh",
        estimatedUrlBytes: 10,
      }],
    });
    expect(await host.galleryQuery({ tab: "presets" })).toHaveLength(1);
    expect(await host.galleryQuery({ tab: "recent" })).toEqual([]);
    await expect(host.saveCurrentToGallery("x")).rejects.toThrow("not implemented yet");
  });

  it("setGalleryItems replaces presets and notifies gallery subscribers", async () => {
    const host = new LiveKernelHost();
    const cb = vi.fn();
    const off = host.subscribeGallery(cb);
    host.setGalleryItems([{
      id: "node",
      title: "Node",
      summary: "Node preset",
      base: "kandelo:shell@abi8",
      packages: ["node@1"],
      bootCommand: ["node"],
      accent: "#43853d",
      glyph: "js",
      estimatedUrlBytes: 20,
    }]);
    off();
    host.setGalleryItems([]);

    expect(cb).toHaveBeenCalledOnce();
    const items = await host.galleryQuery({ tab: "presets" });
    expect(items).toHaveLength(0);
  });

  it("preserves a lazy gallery image resolver without invoking it", async () => {
    const host = new LiveKernelHost();
    const resolveVfsImageUrl = vi.fn(async () => "/node-vfs.vfs.zst");
    host.setGalleryItems([{
      id: "node",
      title: "Node",
      summary: "Node preset",
      base: "kandelo:shell@abi8",
      packages: ["node@1"],
      bootCommand: ["node"],
      resolveVfsImageUrl,
      accent: "#43853d",
      glyph: "js",
      estimatedUrlBytes: 20,
    }]);

    const [item] = await host.galleryQuery({ tab: "presets" });
    expect(resolveVfsImageUrl).not.toHaveBeenCalled();
    await expect(item.resolveVfsImageUrl?.()).resolves.toBe("/node-vfs.vfs.zst");
    expect(resolveVfsImageUrl).toHaveBeenCalledOnce();
  });
});

describe("LiveKernelHost: surface availability", () => {
  it("marks a configured web preview available only after the HTTP response is ready", () => {
    const host = new LiveKernelHost();
    const seen: boolean[] = [];
    host.subscribeSurfaceAvailability((state) => seen.push(state.web));

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "starting",
      message: "Waiting for HTTP response",
    });

    expect(host.getSurfaceAvailability().web).toBe(false);
    expect(seen).toEqual([]);

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "running",
      message: "HTTP bridge ready",
    });

    expect(host.getSurfaceAvailability().web).toBe(true);
    expect(seen).toEqual([true]);
  });

  it("clears web availability when the preview is removed", () => {
    const host = new LiveKernelHost();
    host.setWebPreview({ label: "WordPress", url: "/app/", status: "error" });
    host.setWebPreview(null);

    expect(host.getSurfaceAvailability().web).toBe(false);
  });

  it("tracks web preview pending requests without affecting availability", () => {
    const host = new LiveKernelHost();
    const seen: number[] = [];
    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "running",
    });
    host.subscribeWebPreview((state) => {
      seen.push(state?.pendingRequests ?? 0);
    });

    host.setWebPreviewPendingRequests(2);

    expect(host.getWebPreview()?.pendingRequests).toBe(2);
    expect(host.getSurfaceAvailability().web).toBe(true);
    expect(seen).toEqual([2]);

    host.setWebPreview({
      label: "WordPress",
      url: "/app/",
      status: "running",
      message: "HTTP bridge ready",
    });

    expect(host.getWebPreview()?.pendingRequests).toBe(2);

    host.setWebPreviewPendingRequests(-1);

    expect(host.getWebPreview()?.pendingRequests).toBe(0);
  });
});

describe("LiveKernelHost: snapshot delegates to takeSnapshot", () => {
  it("returns a Snapshot whose descriptor matches the host's", async () => {
    const host = new LiveKernelHost({ descriptor: DUMMY_DESCRIPTOR });
    const snap = await host.snapshot();
    expect(snap.descriptor.id).toBe(DUMMY_DESCRIPTOR.id);
    expect(snap.mode).toBe("preset"); // no inline-overlay → preset
    expect(snap.byteSize).toBeGreaterThan(0);
  });

  it("honors preferMode override", async () => {
    const host = new LiveKernelHost({ descriptor: DUMMY_DESCRIPTOR });
    const snap = await host.snapshot({ preferMode: "manifest" });
    expect(snap.mode).toBe("manifest");
    expect(snap.reason).toContain("Mode forced to manifest");
  });

  it("picks 'delta' when the descriptor carries a small inline overlay", async () => {
    const host = new LiveKernelHost({ descriptor: INLINE_OVERLAY_DESCRIPTOR });
    const snap = await host.snapshot();
    expect(snap.mode).toBe("delta");
    expect(snap.reason).toMatch(/delta/i);
  });
});

describe("Kandelo demo config", () => {
  it("provides generic presentation defaults for web-backed profiles", () => {
    expect(genericDemoPresentation("web")).toMatchObject({
      bootPrimary: "syslog",
      runningPrimary: ["web", "terminal", "syslog"],
      terminalAccess: "drawer",
    });
  });

  it("resolves profile presentation over image defaults", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      presentation: {
        bootPrimary: "syslog",
        runningPrimary: ["terminal", "syslog"],
        terminalAccess: "primary",
        internalsAccess: "drawer",
      },
      profiles: {
        doom: {
          presentation: {
            bootPrimary: "syslog",
            runningPrimary: ["framebuffer", "terminal", "syslog"],
            terminalAccess: "drawer",
            internalsAccess: "drawer",
            autoCommand: "/usr/local/bin/fbdoom -iwad /doom1.wad",
            touchControls: true,
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    const presentation = resolveDemoPresentation(config!, "doom");
    expect(presentation.runningPrimary).toEqual(["framebuffer", "terminal", "syslog"]);
    expect(presentation.terminalAccess).toBe("drawer");
    expect(presentation.autoCommand).toContain("fbdoom");
    expect(presentation.touchControls).toBe(true);
  });

  it("throws when profile metadata is incomplete", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        webapp: {
          presentation: {
            runningPrimary: ["web", "terminal"],
            terminalAccess: "drawer",
            internalsAccess: "drawer",
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoPresentation(config!, "webapp")).toThrow("bootPrimary");
  });

  it("throws when profile metadata has an invalid surface", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        webapp: {
          presentation: {
            bootPrimary: "syslog",
            runningPrimary: ["bogus", "web", "web", "terminal"],
            terminalAccess: "drawer",
            internalsAccess: "drawer",
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoPresentation(config!, "webapp")).toThrow("runningPrimary[0]");
  });

  it("eagerly validates malformed metadata in every profile", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        selected: {
          presentation: {
            bootPrimary: "syslog",
            runningPrimary: ["terminal"],
            terminalAccess: "primary",
            internalsAccess: "drawer",
          },
        },
        unselected: {
          assets: [{ path: "relative.dat", url: "https://example.invalid/data" }],
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => validateKandeloDemoConfig(config!)).toThrow(
      "profiles.unselected.assets[0].path must be absolute",
    );
  });

  it("requires profiles to be an object during eager validation", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: [],
    }));
    expect(config).not.toBeNull();
    expect(() => validateKandeloDemoConfig(config!)).toThrow(
      "profiles must be an object",
    );
  });

  it("resolves and validates profile assets", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      assets: [
        { path: "/common.dat", url: "https://example.invalid/common.dat" },
      ],
      profiles: {
        doom: {
          assets: [
            {
              path: "/doom1.wad",
              url: "https://example.invalid/doom1.wad",
              sha256: "abc123",
              mode: 420,
              devCorsProxy: true,
            },
          ],
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(resolveDemoAssets(config!, "doom")).toEqual([
      { path: "/common.dat", url: "https://example.invalid/common.dat" },
      {
        path: "/doom1.wad",
        url: "https://example.invalid/doom1.wad",
        sha256: "abc123",
        mode: 420,
        devCorsProxy: true,
      },
    ]);
  });

  it("throws when profile assets use a relative path", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        doom: {
          assets: [
            { path: "doom1.wad", url: "https://example.invalid/doom1.wad" },
          ],
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoAssets(config!, "doom")).toThrow("path must be absolute");
  });

  it("resolves and validates guide actions", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {
        node: {
          guide: {
            title: "Node demo",
            groups: [
              {
                title: "REPL",
                actions: [
                  {
                    id: "expr",
                    label: "Expression",
                    description: "Send input.",
                    kind: "terminal.write",
                    payload: "process.version\n",
                  },
                ],
              },
            ],
          },
        },
      },
    }));
    expect(config).not.toBeNull();

    expect(resolveDemoGuide(config!, "node")?.groups?.[0].actions[0].kind).toBe("terminal.write");
    expect(resolveDemoGuide(config!, "missing")).toBeNull();
  });

  it("provides built-in Node guide metadata for stale VFS images", () => {
    const guide = builtinDemoGuide("node");

    expect(guide).toEqual(nodeGuide());
    expect(guide?.title).toBe("SpiderMonkey Node.js demo");
    expect(guide?.groups?.[0].actions.map((action) => action.id)).toContain("install-cowsay");
    expect(builtinDemoGuide("wordpress-sqlite")?.groups?.[0].actions[0]).toMatchObject({
      id: "wp-admin-login",
      kind: "web.wordpressLogin",
    });
  });

  it("provides built-in presentation and assets for stale VFS images", () => {
    expect(builtinDemoPresentation("shell")).toMatchObject({
      runningPrimary: ["terminal", "syslog"],
    });
    expect(builtinDemoPresentation("wordpress-mariadb")).toMatchObject({
      runningPrimary: ["web", "terminal", "syslog"],
    });
    expect(builtinDemoPresentation("doom")).toMatchObject({
      runningPrimary: ["framebuffer", "terminal", "syslog"],
      autoCommand: DOOM_COMMAND,
    });

    expect(builtinDemoAssets("doom")).toEqual([
      expect.objectContaining({ path: "/doom1.wad", devCorsProxy: true }),
    ]);
    expect(builtinDemoAssets("node")).toEqual([]);
  });

  it("rejects duplicate guide action ids", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      guide: {
        title: "Bad guide",
        groups: [
          {
            title: "Actions",
            actions: [
              { id: "dup", label: "One", kind: "terminal.run", payload: "echo one" },
              { id: "dup", label: "Two", kind: "terminal.write", payload: "two\n" },
            ],
          },
        ],
      },
    }));
    expect(config).not.toBeNull();

    expect(() => resolveDemoGuide(config!, "shell")).toThrow("duplicate action id");
  });

  it("returns null when no matching presentation exists", () => {
    const config = parseKandeloDemoConfig(JSON.stringify({
      version: 1,
      profiles: {},
    }));
    expect(config).not.toBeNull();

    expect(resolveDemoPresentation(config!, "missing")).toBeNull();
  });
});

describe("image-owned Kandelo demo config", () => {
  function fixture(
    source: string | Uint8Array,
    options: { mode?: number; size?: number; missing?: boolean } = {},
  ) {
    const bytes = typeof source === "string"
      ? new TextEncoder().encode(source)
      : source;
    let cursor = 0;
    const state = { openCalls: 0, closeCalls: 0 };
    const fs = {
      lstat() {
        if (options.missing) throw Object.assign(new Error("ENOENT"), { code: -2 });
        return {
          mode: options.mode ?? (0x8000 | 0o644),
          size: options.size ?? bytes.byteLength,
        };
      },
      open() {
        state.openCalls += 1;
        return 1;
      },
      read(_handle: number, buffer: Uint8Array, _offset: number | null, length: number) {
        const count = Math.min(length, bytes.byteLength - cursor);
        if (count > 0) buffer.set(bytes.subarray(cursor, cursor + count));
        cursor += count;
        return count;
      },
      close() {
        state.closeCalls += 1;
      },
    };
    return { fs, state };
  }

  it("reads and eagerly validates a bounded regular config", () => {
    const { fs } = fixture(JSON.stringify({
      version: 1,
      profiles: {
        shell: {
          presentation: {
            bootPrimary: "syslog",
            runningPrimary: ["terminal"],
            terminalAccess: "primary",
            internalsAccess: "drawer",
          },
        },
      },
    }));
    expect(readKandeloDemoConfigFromVfs(fs)?.profiles).toHaveProperty("shell");
  });

  it("returns null when the image has no demo config", () => {
    const { fs } = fixture("", { missing: true });
    expect(readKandeloDemoConfigFromVfs(fs)).toBeNull();
  });

  it("rejects oversized config before opening it", () => {
    const { fs, state } = fixture("", {
      size: MAX_KANDELO_DEMO_CONFIG_BYTES + 1,
    });
    expect(() => readKandeloDemoConfigFromVfs(fs)).toThrow("exceeds 262144 bytes");
    expect(state.openCalls).toBe(0);
  });

  it.each([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid stat size %s before opening it",
    (size) => {
      const { fs, state } = fixture("", { size });
      expect(() => readKandeloDemoConfigFromVfs(fs)).toThrow("has an invalid size");
      expect(state.openCalls).toBe(0);
    },
  );

  it("rejects an incomplete read and still closes the file", () => {
    const { fs, state } = fixture("{}", { size: 3 });
    expect(() => readKandeloDemoConfigFromVfs(fs)).toThrow(
      "could not be read completely",
    );
    expect(state.openCalls).toBe(1);
    expect(state.closeCalls).toBe(1);
  });

  it("rejects non-regular config nodes", () => {
    const { fs } = fixture("{}", { mode: 0xa000 | 0o777 });
    expect(() => readKandeloDemoConfigFromVfs(fs)).toThrow("must be a regular file");
  });

  it("rejects invalid UTF-8 and unsupported versions", () => {
    const invalidUtf8 = fixture(new Uint8Array([0xff])).fs;
    expect(() => readKandeloDemoConfigFromVfs(invalidUtf8)).toThrow(
      "is not valid UTF-8",
    );
    const unsupported = fixture('{"version":2}').fs;
    expect(() => readKandeloDemoConfigFromVfs(unsupported)).toThrow(
      "has unsupported /etc/kandelo/demo.json version",
    );
  });

  it("rejects malformed JSON", () => {
    const { fs } = fixture('{"version":1');
    expect(() => readKandeloDemoConfigFromVfs(fs)).toThrow("is not valid JSON");
  });

  it("rejects malformed metadata in an unselected profile", () => {
    const { fs } = fixture(JSON.stringify({
      version: 1,
      profiles: {
        selected: {},
        unselected: {
          guide: {
            title: "Broken",
            groups: [{ title: "Actions", actions: "not-an-array" }],
          },
        },
      },
    }));
    expect(() => readKandeloDemoConfigFromVfs(fs)).toThrow(
      "profiles.unselected.guide.groups[0].actions must be an array",
    );
  });
});

describe("experimental terminal session image configuration", () => {
  it("accepts exact initial and after-exit programs", () => {
    const config = parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: "/usr/bin/login",
        argv: ["login", "-p", "-f", "maker"],
        uid: 0,
        gid: 0,
      },
      afterExit: {
        path: "/usr/bin/login",
        argv: ["login", "-p"],
        uid: 0,
        gid: 0,
      },
    }));

    expect(config).toEqual({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: "/usr/bin/login",
        argv: ["login", "-p", "-f", "maker"],
        uid: 0,
        gid: 0,
      },
      afterExit: {
        path: "/usr/bin/login",
        argv: ["login", "-p"],
        uid: 0,
        gid: 0,
      },
    });
    expect(experimentalTerminalSessionPolicy(config)).toMatchObject({
      initial: {
        programPath: "/usr/bin/login",
        argv: ["login", "-p", "-f", "maker"],
        uid: 0,
        gid: 0,
      },
      afterExit: {
        programPath: "/usr/bin/login",
        argv: ["login", "-p"],
        uid: 0,
        gid: 0,
      },
    });
  });

  it("accepts a session with no after-exit program", () => {
    const config = parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: { path: "/bin/sh", argv: ["sh", "-i"], uid: 1000, gid: 1000 },
    }));

    expect(config.afterExit).toBeUndefined();
    expect(experimentalTerminalSessionPolicy(config).afterExit).toBeUndefined();
  });

  it("rejects executable paths that can escape or drift", () => {
    expect(() => parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: "/opt/kandelo/../bin/dash",
        argv: ["dash", "-i"],
        uid: 0,
        gid: 0,
      },
    }))).toThrow("normalized");
    expect(() => parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: "bin/dash",
        argv: ["dash", "-i"],
        uid: 0,
        gid: 0,
      },
    }))).toThrow("absolute guest file path");
  });

  it("rejects unknown fields, invalid ids, and oversized argv", () => {
    expect(() => parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: "/bin/sh",
        argv: ["sh", "-i"],
        uid: -1,
        gid: 0,
      },
    }))).toThrow("uid");
    expect(() => parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 1,
      initial: {
        path: "/bin/sh",
        argv: Array.from({ length: 65 }, () => "sh"),
        uid: 0,
        gid: 0,
      },
    }))).toThrow("exceeds 64 arguments");
  });

  it("rejects unsupported kind and version", () => {
    expect(() => parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-experimental-terminal-session",
      version: 2,
      initial: { path: "/bin/sh", argv: ["sh"], uid: 0, gid: 0 },
    }))).toThrow("unsupported");
    expect(() => parseExperimentalTerminalSession(JSON.stringify({
      kind: "kandelo-terminal-session",
      version: 1,
      initial: { path: "/bin/sh", argv: ["sh"], uid: 0, gid: 0 },
    }))).toThrow("unsupported");
  });
});

describe("Kandelo VFS consumer capacity contract", () => {
  it("gives shell-derived products independent runtime capacity", () => {
    expect(MAIN_SHELL_VFS_PROFILE_MAX_BYTES).toBe(512 * 1024 * 1024);
    expect(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES).toBe(768 * 1024 * 1024);
    expect(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES).toBeGreaterThan(
      MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
    );
    expect(SHELL_DERIVED_VFS_MIN_FREE_BYTES).toBe(64 * 1024 * 1024);
    expect(SHELL_DERIVED_VFS_MIN_FREE_INODES).toBe(8 * 1024);
  });

  it("accepts the main shell's exact 512 MiB declaration", () => {
    expect(() => assertVfsImageFitsProfile(
      {
        byteLength: MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
        maxByteLength: MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
      },
      MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
      MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
      "main-shell.vfs.zst",
    )).not.toThrow();
  });

  it("rejects metadata drift and oversized custom images before allocation", () => {
    expect(() => assertVfsImageFitsProfile(
      { byteLength: 16 * 1024 * 1024, maxByteLength: 512 * 1024 * 1024 },
      MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
      256 * 1024 * 1024,
      "custom.vfs.zst",
    )).toThrow("metadata does not match");
    expect(() => assertVfsImageFitsProfile(
      { byteLength: 16 * 1024 * 1024, maxByteLength: 768 * 1024 * 1024 },
      MAIN_SHELL_VFS_PROFILE_MAX_BYTES,
      undefined,
      "custom.vfs.zst",
    )).toThrow("profile permits");
  });
});
