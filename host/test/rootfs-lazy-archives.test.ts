import { describe, it, expect } from "vitest";
import { buildRootfsLazyWiring } from "../src/vfs/rootfs-lazy-archives";
import type { SerializedLazyArchiveEntry } from "../src/vfs/memory-fs";

/** Let an in-flight async archive fetch (and its chained `.then`s) settle
 * before making assertions. A macrotask tick is used rather than a fixed
 * number of microtask ticks so the wait is robust to engine-internal
 * microtask-queueing changes around thenable resolution. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal fake `SerializedLazyArchiveEntry` group. Only the fields the
 * builder reads are populated; unused required fields get placeholder
 * values so the object satisfies the type. */
function makeGroup(
  overrides: Partial<SerializedLazyArchiveEntry>,
): SerializedLazyArchiveEntry {
  return {
    kind: "kandelo-deferred-tree-v3",
    url: "",
    mountPrefix: "/",
    materialized: false,
    entries: [],
    ...overrides,
  };
}

describe("buildRootfsLazyWiring", () => {
  const ARCHIVE_SIZE = 20;
  const archiveBytes = new Uint8Array(ARCHIVE_SIZE);
  for (let i = 0; i < ARCHIVE_SIZE; i++) archiveBytes[i] = i;

  function makeFetcher() {
    const calls: string[] = [];
    let resolveFetch!: (v: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => {
      resolveFetch = resolve;
    });
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      return pending;
    };
    return { fetcher, calls, settle: () => resolveFetch(archiveBytes) };
  }

  function buildEntries(): SerializedLazyArchiveEntry[] {
    const validGroup = makeGroup({
      content: {
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: "deadbeef",
        bytes: ARCHIVE_SIZE,
        expandedBytes: ARCHIVE_SIZE * 2,
        sourceEntryCount: 4,
        transports: ["u1", "u2"],
      },
      entries: [
        {
          vfsPath: "/a/dir",
          ino: 1,
          size: 0,
          isSymlink: false,
          deleted: false,
          type: undefined,
        },
        {
          vfsPath: "/a/link",
          ino: 2,
          size: 0,
          isSymlink: true,
          deleted: false,
          type: "symlink",
          sourcePath: "bin/link",
        },
        {
          vfsPath: "/a/f",
          ino: 3,
          size: 6,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/f",
        },
        {
          vfsPath: "/a/gone",
          ino: 4,
          size: 0,
          isSymlink: false,
          deleted: true,
          type: "file",
          sourcePath: "bin/gone",
        },
        {
          vfsPath: "/a/nosource",
          ino: 5,
          size: 1,
          isSymlink: false,
          deleted: false,
          type: "file",
        },
      ],
    });

    // Group missing both content.bytes and integrity.bytes: must be skipped
    // entirely (no id minted, no members, no archive-table entry).
    const skippedGroup = makeGroup({
      content: undefined,
      integrity: undefined,
      url: "",
      entries: [
        {
          vfsPath: "/b/should-not-appear",
          ino: 10,
          size: 3,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/should-not-appear",
        },
      ],
    });

    return [skippedGroup, validGroup];
  }

  it("(a) includes only the live file member with correct mapping", () => {
    const { fetcher } = makeFetcher();
    const { lazyInput } = buildRootfsLazyWiring(buildEntries(), fetcher);

    expect(lazyInput.files.size).toBe(1);
    expect(lazyInput.files.get("/a/f")).toEqual({
      archiveId: 1,
      sourcePath: "bin/f",
    });
    expect(lazyInput.files.has("/a/dir")).toBe(false);
    expect(lazyInput.files.has("/a/link")).toBe(false);
    expect(lazyInput.files.has("/a/gone")).toBe(false);
    expect(lazyInput.files.has("/a/nosource")).toBe(false);
  });

  it("(b) archives table has one entry with the minted id and raw size", () => {
    const { fetcher } = makeFetcher();
    const { lazyInput } = buildRootfsLazyWiring(buildEntries(), fetcher);

    expect(lazyInput.archives).toEqual([{ archiveId: 1, size: ARCHIVE_SIZE }]);
  });

  it("(g) a group missing content.bytes and integrity.bytes is skipped, and the surviving group still gets a stable id", () => {
    const { fetcher } = makeFetcher();
    const { lazyInput } = buildRootfsLazyWiring(buildEntries(), fetcher);

    expect(lazyInput.files.has("/b/should-not-appear")).toBe(false);
    // Only one archive-table entry total (the skipped group contributed none).
    expect(lazyInput.archives).toHaveLength(1);
    expect(lazyInput.archives[0]!.archiveId).toBe(1);
    expect(lazyInput.files.get("/a/f")!.archiveId).toBe(1);
  });

  it("(c) first provider call returns EAGAIN and invokes the fetcher", () => {
    const { fetcher, calls } = makeFetcher();
    const { archiveProvider } = buildRootfsLazyWiring(buildEntries(), fetcher);

    const dest = new Uint8Array(8);
    const result = archiveProvider(1, 0n, dest);

    expect(result).toBe(-11);
    expect(calls).toEqual(["u1"]);
  });

  it("(d) after the fetch settles, offset 0 fills dest with the archive prefix", async () => {
    const { fetcher, settle } = makeFetcher();
    const { archiveProvider } = buildRootfsLazyWiring(buildEntries(), fetcher);

    const dest0 = new Uint8Array(8);
    expect(archiveProvider(1, 0n, dest0)).toBe(-11);

    settle();
    await flushMicrotasks();

    const dest = new Uint8Array(8);
    const n = archiveProvider(1, 0n, dest);
    expect(n).toBe(8);
    expect(dest).toEqual(archiveBytes.subarray(0, 8));
  });

  it("(e) a nonzero offset returns the correct mid-archive slice", async () => {
    const { fetcher, settle } = makeFetcher();
    const { archiveProvider } = buildRootfsLazyWiring(buildEntries(), fetcher);

    archiveProvider(1, 0n, new Uint8Array(1));
    settle();
    await flushMicrotasks();

    const dest = new Uint8Array(5);
    const n = archiveProvider(1, 10n, dest);
    expect(n).toBe(5);
    expect(dest).toEqual(archiveBytes.subarray(10, 15));
  });

  it("(f) a call past the end returns 0", async () => {
    const { fetcher, settle } = makeFetcher();
    const { archiveProvider } = buildRootfsLazyWiring(buildEntries(), fetcher);

    archiveProvider(1, 0n, new Uint8Array(1));
    settle();
    await flushMicrotasks();

    const dest = new Uint8Array(4);
    const n = archiveProvider(1, BigInt(ARCHIVE_SIZE), dest);
    expect(n).toBe(0);
  });

  it("returns EIO for an archive id never minted (contract violation)", () => {
    const { fetcher } = makeFetcher();
    const { archiveProvider } = buildRootfsLazyWiring(buildEntries(), fetcher);

    const dest = new Uint8Array(4);
    expect(archiveProvider(999, 0n, dest)).toBe(-5);
  });

  it("falls back to `url` as the sole transport when content.transports is absent", () => {
    const calls: string[] = [];
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      return archiveBytes;
    };

    const group = makeGroup({
      content: undefined,
      integrity: { sha256: "x", bytes: ARCHIVE_SIZE },
      url: "legacy-url",
      entries: [
        {
          vfsPath: "/c/f",
          ino: 20,
          size: 6,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/f",
        },
      ],
    });

    const { lazyInput, archiveProvider } = buildRootfsLazyWiring(
      [group],
      fetcher,
    );
    expect(lazyInput.archives).toEqual([{ archiveId: 1, size: ARCHIVE_SIZE }]);

    archiveProvider(1, 0n, new Uint8Array(1));
    expect(calls).toEqual(["legacy-url"]);
  });

  it("tries the next transport on a size mismatch and serves from the good one", async () => {
    const calls: string[] = [];
    const badBytes = new Uint8Array(ARCHIVE_SIZE - 1); // wrong length
    const fetcher = async (url: string): Promise<Uint8Array> => {
      calls.push(url);
      if (url === "bad-url") return badBytes;
      return archiveBytes;
    };

    const group = makeGroup({
      content: {
        decoder: "zip-v1",
        mediaType: "application/zip",
        sha256: "deadbeef",
        bytes: ARCHIVE_SIZE,
        expandedBytes: ARCHIVE_SIZE * 2,
        sourceEntryCount: 1,
        transports: ["bad-url", "good-url"],
      },
      entries: [
        {
          vfsPath: "/c/f",
          ino: 20,
          size: 6,
          isSymlink: false,
          deleted: false,
          type: "file",
          sourcePath: "bin/f",
        },
      ],
    });

    const { archiveProvider } = buildRootfsLazyWiring([group], fetcher);

    expect(archiveProvider(1, 0n, new Uint8Array(1))).toBe(-11);
    // Let the bad-url fetch settle and the good-url fetch settle in turn.
    await flushMicrotasks();

    expect(calls).toEqual(["bad-url", "good-url"]);

    const dest = new Uint8Array(4);
    const n = archiveProvider(1, 0n, dest);
    expect(n).toBe(4);
    expect(dest).toEqual(archiveBytes.subarray(0, 4));
  });
});
