/**
 * Bridge between System A (`MemoryFileSystem` lazy archive groups) and
 * System B (the in-kernel rootfs overlay's `LazyMember` archive reads).
 *
 * `buildRootfsLazyWiring` consumes `MemoryFileSystem.exportLazyArchiveEntries()`
 * output and produces, from one pass over the groups:
 *  - a `RootfsLazyInput` (fed to `emitRootfsManifest` so the manifest walker
 *    emits `KIND_LAZY_FILE` linkage for lazy members), and
 *  - an `archiveProvider` closure (fed to `configureRootfsOverlay`) that
 *    answers the kernel's `host_fetch_archive(archive_id, offset, dest)`
 *    calls by fetching the whole raw archive once, caching it, and reporting
 *    `EAGAIN` while the fetch is outstanding.
 *
 * Both outputs share ONE `Map<archiveId, ...>` and one id-minting pass over
 * `entries`, so the manifest's archive table and the provider's lookup table
 * can never drift relative to each other.
 */

import type { SerializedLazyArchiveEntry } from "./memory-fs";
import type {
  RootfsLazyArchive,
  RootfsLazyFile,
  RootfsLazyInput,
} from "./rootfs-manifest";

const EAGAIN = -11;
const EIO = -5;

type ArchiveState = "idle" | "fetching" | Uint8Array | { error: true };

interface ArchiveRecord {
  readonly transports: string[];
  readonly size: number;
  state: ArchiveState;
}

/**
 * Build the `RootfsLazyInput` (manifest linkage) and the `host_fetch_archive`
 * provider from one export snapshot of `MemoryFileSystem`'s lazy archive
 * groups. Pure: touches neither `MemoryFileSystem` nor the global `fetch`.
 *
 * `fetcher` is the exact transport already wired to
 * `MemoryFileSystem.setLazyFetcher` (closed-asset fetcher, CORS-proxy
 * fetcher, etc.) — the provider never invents its own transport.
 */
export function buildRootfsLazyWiring(
  entries: SerializedLazyArchiveEntry[],
  fetcher: (url: string) => Promise<Uint8Array>,
): {
  lazyInput: RootfsLazyInput;
  archiveProvider: (
    archiveId: number,
    offset: bigint,
    dest: Uint8Array,
  ) => number;
} {
  const files = new Map<string, RootfsLazyFile>();
  const archives: RootfsLazyArchive[] = [];
  const records = new Map<number, ArchiveRecord>();

  let nextArchiveId = 1;

  for (const group of entries) {
    const size = group.content?.bytes ?? group.integrity?.bytes;
    if (size === undefined) {
      // Legacy group with no declared raw archive size: a truthful gap, not
      // a guess. Skip it entirely — no id, no members, no archive entry.
      continue;
    }

    const transports =
      group.content?.transports && group.content.transports.length > 0
        ? group.content.transports
        : typeof group.url === "string" && group.url.length > 0
          ? [group.url]
          : undefined;
    if (transports === undefined) {
      // No transport mirrors and no legacy `url`: unfetchable. Skip.
      continue;
    }

    const archiveId = nextArchiveId++;
    archives.push({ archiveId, size });
    records.set(archiveId, { transports, size, state: "idle" });

    for (const member of group.entries) {
      if (member.deleted) continue;
      if (member.isSymlink) continue;
      if (member.type !== undefined && member.type !== "file") continue;
      if (!member.sourcePath) continue;

      files.set(member.vfsPath, {
        archiveId,
        sourcePath: member.sourcePath,
      });
    }
  }

  const archiveProvider = (
    archiveId: number,
    offset: bigint,
    dest: Uint8Array,
  ): number => {
    const record = records.get(archiveId);
    if (!record) {
      // The kernel only asks for ids this builder minted; an unknown id is a
      // contract violation between the manifest and the provider.
      return EIO;
    }

    const { state } = record;
    if (state instanceof Uint8Array) {
      const start = Number(offset);
      if (start >= state.length) return 0;
      const n = Math.min(dest.length, state.length - start);
      dest.set(state.subarray(start, start + n));
      return n;
    }

    if (state === "idle") {
      record.state = "fetching";
      void fetchArchive(record, fetcher);
      return EAGAIN;
    }

    if (state === "fetching") {
      return EAGAIN;
    }

    // { error: true }
    return EIO;
  };

  return { lazyInput: { files, archives }, archiveProvider };
}

/** Try each transport in order; on the first successful fetch whose length
 * matches the declared archive size, publish it as the cached raw archive.
 * A size mismatch is treated as a failed mirror, not a fatal error, so the
 * next transport gets a chance. Never throws — errors are recorded on the
 * record itself for the synchronous provider to observe. */
async function fetchArchive(
  record: ArchiveRecord,
  fetcher: (url: string) => Promise<Uint8Array>,
): Promise<void> {
  for (const url of record.transports) {
    try {
      const bytes = await fetcher(url);
      if (bytes.length === record.size) {
        record.state = bytes;
        return;
      }
      // Wrong/corrupt mirror: fall through and try the next transport.
    } catch {
      // Failed transport: fall through and try the next transport.
    }
  }
  record.state = { error: true };
}
