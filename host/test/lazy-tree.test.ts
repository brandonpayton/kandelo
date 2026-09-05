import { createHash } from "node:crypto";
import { gzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryFileSystem,
  type LazyArchiveFileEntry,
  type LazyTreeGroup,
  type LazyTreeActivation,
  type LazyTreeRegistrationEntry,
} from "../src/vfs/memory-fs";
import {
  VFS_DEFERRED_TREE_COLLECTION_LIMITS,
  VFS_DEFERRED_TREE_LIMITS,
} from "../src/vfs/deferred-tree-limits";
import {
  applyLazyTreeByteTransformRecipe,
  decodeMaterializationBytes,
  encodeMaterializationBytes,
  validateLazyTreeMaterializationPlan,
  type LazyTreeMaterializationPlan,
  type LazyTreeMaterializationSourceInventory,
} from "../src/vfs/materialization-plan";

const BLOCK = 512;
const O_WRONLY_CREAT = 0x0041;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink";
  mode: number;
  data?: string;
  target?: string;
}

describe("format-neutral deferred trees", () => {
  it("keeps public deferred-tree bounds reloadable and accounts for pending base usage", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const pending = fs.pendingDeferredTreeUsage();

    expect(pending).toEqual({
      groups: 1,
      archiveBytes: fixture.content.bytes,
      expandedBytes: fixture.content.expandedBytes,
      payloadBytes: 7,
      entries: fixture.inventory.length,
    });
    expect(() => fs.assertCanAppendDeferredTreeUsage({
      groups: VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups - pending.groups,
      archiveBytes:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes -
        pending.archiveBytes,
      expandedBytes:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxExpandedBytes -
        pending.expandedBytes,
      payloadBytes:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxPayloadBytes -
        pending.payloadBytes,
      entries:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxEntries - pending.entries,
    })).not.toThrow();

    const overBoundary = [
      ["groups", /group cap/],
      ["archiveBytes", /archive-byte cap/],
      ["expandedBytes", /expansion cap/],
      ["payloadBytes", /payload-byte cap/],
      ["entries", /entry-count cap/],
    ] as const;
    for (const [field, error] of overBoundary) {
      const additional = {
        groups: 0,
        archiveBytes: 0,
        expandedBytes: 0,
        payloadBytes: 0,
        entries: 0,
      };
      const limitField = field === "groups"
        ? "maxGroups"
        : field === "archiveBytes"
          ? "maxArchiveBytes"
          : field === "expandedBytes"
            ? "maxExpandedBytes"
            : field === "payloadBytes"
              ? "maxPayloadBytes"
              : "maxEntries";
      additional[field] =
        VFS_DEFERRED_TREE_COLLECTION_LIMITS[limitField] - pending[field] + 1;
      expect(() => fs.assertCanAppendDeferredTreeUsage(additional)).toThrow(
        error,
      );
    }

    const boundary = MemoryFileSystem.create(
      new SharedArrayBuffer(8 * 1024 * 1024),
    );
    const third = Math.floor(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes / 3,
    );
    const archiveBytes = [
      third,
      third,
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes - 2 * third,
    ];
    for (const [index, bytes] of archiveBytes.entries()) {
      const tree = tarTreeFixture("first-use", `archive-${index}`);
      boundary.registerLazyTree(
        { ...tree.content, bytes },
        tree.inventory,
        "/",
        tree.activation,
      );
    }
    expect(boundary.pendingDeferredTreeUsage().archiveBytes).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes,
    );
    const image = await boundary.saveImage();
    expect(MemoryFileSystem.fromImage(image).pendingDeferredTreeUsage().archiveBytes)
      .toBe(VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes);

    const over = structuredClone(boundary.exportLazyArchiveEntries());
    over[2]!.content!.bytes += 1;
    over[2]!.integrity!.bytes += 1;
    expect(() =>
      MemoryFileSystem.fromImage(replaceLazyArchiveMetadata(image, over))
    )
      .toThrow(/archive-byte cap/);
  });

  it("refuses to register a 513th pending group and round-trips the exact boundary", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024 * 1024));
    const registration = (index: number) => {
      const root = `group-${index.toString().padStart(3, "0")}`;
      return {
        content: {
          ...fixture.content,
          transports: [`https://example.invalid/${root}.tar.gz`],
        },
        inventory: fixture.inventory.map((entry) => ({
          ...entry,
          vfsPath: entry.vfsPath.replace("/runtime", `/${root}`),
          sourcePath: entry.sourcePath.replace("runtime", root),
          ...(entry.target === undefined
            ? {}
            : { target: entry.target.replace("/runtime", `/${root}`) }),
          ...(entry.inodeGroup === undefined
            ? {}
            : { inodeGroup: entry.inodeGroup.replace("runtime", root) }),
        })),
        activation: {
          mode: "first-use" as const,
          capabilities: [`test:${root}`],
          roots: [`/${root}`],
        },
      };
    };
    for (
      let index = 0;
      index < VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups;
      index += 1
    ) {
      const tree = registration(index);
      fs.registerLazyTree(tree.content, tree.inventory, "/", tree.activation);
    }
    expect(fs.pendingDeferredTreeUsage().groups).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups,
    );
    const image = await fs.saveImage();
    expect(MemoryFileSystem.fromImage(image).pendingDeferredTreeUsage().groups).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups,
    );

    const extra = registration(VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups);
    expect(() => fs.registerLazyTree(
      extra.content,
      extra.inventory,
      "/",
      extra.activation,
    )).toThrow(/Cannot register another lazy archive group/);
    expect(() => fs.lstat(`/${extra.activation.roots[0]!.slice(1)}`)).toThrow();
  });

  it("accepts the filesystem root as the default first-use activation root", () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();

    fs.registerLazyTree(fixture.content, fixture.inventory);

    const serialized = fs.exportLazyArchiveEntries()[0];
    expect(serialized?.kind).toBe("kandelo-deferred-tree-v1");
    expect(serialized?.mountPrefix).toBe("/");
    expect(serialized?.entries.every((entry) => entry.vfsPath.startsWith("/")))
      .toBe(true);
    expect(serialized?.activation).toEqual({
      mode: "first-use",
      capabilities: ["deferred-tree"],
      roots: ["/"],
    });
  });

  it("materializes a TAR+gzip tree once while preserving hardlink identity", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);

    expect(fetcher).not.toHaveBeenCalled();
    const beforeTarget = fs.lstat("/runtime/tool");
    const beforeAlias = fs.lstat("/runtime/tool-hardlink");
    expect(beforeAlias.ino).toBe(beforeTarget.ino);
    expect(beforeTarget.nlink).toBe(2);
    expect(beforeAlias.size).toBe(7);

    await expect(Promise.all([
      fs.preparePath("/runtime/tool"),
      fs.preparePath("/runtime/tool-hardlink"),
    ])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readText(fs, "/runtime/tool")).toBe("payload");
    expect(readText(fs, "/runtime/tool-hardlink")).toBe("payload");
    const afterTarget = fs.lstat("/runtime/tool");
    const afterAlias = fs.lstat("/runtime/tool-hardlink");
    expect(afterAlias.ino).toBe(afterTarget.ino);
    expect(afterTarget.nlink).toBe(2);
  });

  it("carries a deferred tree onto captured bytes, and onto the next capture", async () => {
    const first = tarTreeFixture("first-use", "captured-a");
    const second = tarTreeFixture("first-use", "captured-b");
    const image = createFs();
    await registerAtomicTrees(image, "atomic:captured", [first, second]);
    const payloads = new Map([
      ["https://example.invalid/captured-a.tar.gz", first.payload],
      ["https://example.invalid/captured-b.tar.gz", second.payload],
    ]);

    // A machine checkpoint carries the filesystem buffer alone, and a tree's
    // registration is not in it. Mounted on those bytes by themselves,
    // `/captured-a/tool` is a file that exists and can never be read.
    const captured = new SharedArrayBuffer(image.sharedBuffer.byteLength);
    new Uint8Array(captured).set(new Uint8Array(image.sharedBuffer));
    expect(MemoryFileSystem.fromExisting(captured).isPathDeferred("/captured-a/tool"))
      .toBe(false);

    const restored = image.mountCapturedBytes(captured);
    expect(restored.isPathDeferred("/captured-a/tool")).toBe(true);

    // The computer that took the machine can hand it on again, so what it
    // mounted has to be exportable in turn. A sealed group re-admitted as
    // unverified would refuse to serialize and strand the machine there.
    const handedOn = new SharedArrayBuffer(restored.sharedBuffer.byteLength);
    new Uint8Array(handedOn).set(new Uint8Array(restored.sharedBuffer));
    const restoredAgain = restored.mountCapturedBytes(handedOn);
    restoredAgain.setLazyFetcher(async (url) => new Response(payloads.get(url)!));
    await expect(restoredAgain.preparePath("/captured-a/tool")).resolves.toBe(true);
    expect(readText(restoredAgain, "/captured-a/tool")).toBe("payload");
  });

  it("validates and applies the exact generic byte-transform contract", () => {
    const plan = exactGenericMaterializationPlan();
    const inventory: LazyTreeMaterializationSourceInventory = {
      entries: [{
        sourcePath: "bin/tool",
        type: "file",
        size: 5,
      }],
    };

    expect(validateLazyTreeMaterializationPlan(plan, inventory)).toEqual(plan);
    expect(
      decoder.decode(applyLazyTreeByteTransformRecipe(
        encoder.encode("/old/"),
        plan.recipes[0]!,
      )),
    ).toBe("/new/");
    expect(decodeMaterializationBytes(encodeMaterializationBytes(
      new Uint8Array([0, 1, 15, 16, 255]),
    ))).toEqual(new Uint8Array([0, 1, 15, 16, 255]));
    expect(decoder.decode(applyLazyTreeByteTransformRecipe(
      encoder.encode("x/x"),
      {
        id: "length-changing",
        replacements: [{ matchHex: "78", replacementHex: "616263" }],
        rejectHex: ["78"],
      },
    ))).toBe("abc/abc");
    expect(() => applyLazyTreeByteTransformRecipe(
      new Uint8Array(32_769),
      {
        id: "bounded-expansion",
        replacements: [{
          matchHex: "00",
          replacementHex: "01".repeat(8192),
        }],
        rejectHex: ["00"],
      },
    )).toThrow(/transformed-byte limit/);
  });

  it("rejects malformed or unbounded generic materialization plans", () => {
    const inventory: LazyTreeMaterializationSourceInventory = {
      entries: [{
        sourcePath: "bin/tool",
        type: "file",
        size: 5,
      }],
    };
    const cases: Array<{
      label: string;
      mutate: (plan: Record<string, any>) => void;
      error: RegExp;
    }> = [{
      label: "unknown key",
      mutate: (plan) => plan.unexpected = true,
      error: /unexpected fields/,
    }, {
      label: "duplicate recipe",
      mutate: (plan) => plan.recipes.push(structuredClone(plan.recipes[0])),
      error: /recipe 1 id is invalid|duplicates recipe/,
    }, {
      label: "duplicate transform",
      mutate: (plan) => plan.transforms.push(structuredClone(plan.transforms[0])),
      error: /repeats transform/,
    }, {
      label: "odd hexadecimal bytes",
      mutate: (plan) => plan.assertions[0].bytesHex = "0",
      error: /canonical bounded hexadecimal bytes/,
    }, {
      label: "non-hexadecimal bytes",
      mutate: (plan) => plan.assertions[0].bytesHex = "zz",
      error: /canonical bounded hexadecimal bytes/,
    }, {
      label: "replacement count",
      mutate: (plan) => {
        plan.recipes[0].replacements = new Array(33).fill({
          matchHex: "00",
          replacementHex: "00",
        });
      },
      error: /replacements must contain 0 to 32 items/,
    }, {
      label: "missing source member",
      mutate: (plan) => plan.transforms[0].sourcePath = "bin/missing",
      error: /not a regular source/,
    }, {
      label: "unsafe source path",
      mutate: (plan) => plan.transforms[0].sourcePath = "bin/../tool",
      error: /canonical relative path/,
    }, {
      label: "decoded plan byte budget",
      mutate: (plan) => plan.assertions[0].bytesHex = "00".repeat(1_048_577),
      error: /decoded byte limit|canonical bounded hexadecimal bytes/,
    }];

    for (const testCase of cases) {
      const plan = structuredClone(exactGenericMaterializationPlan()) as
        unknown as Record<string, any>;
      testCase.mutate(plan);
      expect(
        () => validateLazyTreeMaterializationPlan(plan, inventory),
        testCase.label,
      ).toThrow(testCase.error);
    }
  });

  it("uses Unicode-scalar order for generic source inventories and plans", () => {
    const bmp = "\ue000";
    const nonBmp = "\u{10000}";
    const sourceEntries = [
      { sourcePath: bmp, type: "file" as const, size: 1 },
      { sourcePath: nonBmp, type: "file" as const, size: 1 },
    ];
    const plan: LazyTreeMaterializationPlan = {
      schema: 1,
      kind: "archive-byte-transforms-v1",
      assertions: sourceEntries.map((entry) => ({
        sourcePath: entry.sourcePath,
        bytesHex: "78",
      })),
      recipes: [],
      transforms: [],
    };
    expect(validateLazyTreeMaterializationPlan(plan, { entries: sourceEntries }))
      .toEqual(plan);
    expect(() => validateLazyTreeMaterializationPlan({
      ...plan,
      assertions: [...plan.assertions].reverse(),
    }, { entries: sourceEntries })).toThrow(/canonical order/);
    expect(() => validateLazyTreeMaterializationPlan({
      ...plan,
      assertions: [{ sourcePath: "\ud800", bytesHex: "78" }],
    }, {
      entries: [{ sourcePath: "\ud800", type: "file", size: 1 }],
    })).toThrow(/Unicode scalar values/);

    const specs: TarSpec[] = sourceEntries.map((entry) => ({
      path: entry.sourcePath,
      mode: 0o644,
      data: "x",
    }));
    const tar = tarBytes(specs);
    const payload = gzipSync(tar);
    const content = {
      decoder: "tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: sourceEntries.length,
      transports: ["https://example.invalid/unicode-scalars.tar.gz"],
      source: {
        schema: 1 as const,
        kind: "archive-source-inventory-v1" as const,
        entries: sourceEntries.map((entry) => ({
          ...entry,
          mode: 0o644,
        })),
      },
    };
    const inventory = sourceEntries.map((entry) => ({
      vfsPath: `/${entry.sourcePath}`,
      sourcePath: entry.sourcePath,
      materialization: "archive" as const,
      type: "file" as const,
      mode: 0o644,
      size: 1,
      inodeGroup: `unicode:${entry.sourcePath}`,
    }));
    expect(() => createFs().registerLazyTree(content, inventory)).not.toThrow();
    expect(() => createFs().registerLazyTree({
      ...content,
      source: {
        ...content.source,
        entries: [...content.source.entries].reverse(),
      },
    }, inventory)).toThrow(/canonical path order/);
  });

  it("materializes a transformed generic TAR identically in eager and lazy paths", async () => {
    const fixture = transformedGenericTarTreeFixture();
    const lazy = createFs();
    lazy.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/srv",
      fixture.activation,
    );
    lazy.setLazyFetcher(async () => new Response(fixture.payload));
    await expect(lazy.preparePath("/srv/bin/tool-alias")).resolves.toBe(true);

    const eager = createFs();
    const handle = eager.registerLazyTreeWithMaterializationHandle(
      { ...fixture.content, transports: [] },
      fixture.inventory,
      "/srv",
      fixture.activation,
    );
    await expect(
      eager.materializeRegisteredDeferredTree(handle, fixture.payload),
    ).resolves.toBe(true);

    for (const path of [
      "/srv",
      "/srv/bin",
      "/srv/bin/tool",
      "/srv/bin/tool-alias",
      "/srv/current",
    ]) {
      const lazyStat = lazy.lstat(path);
      const eagerStat = eager.lstat(path);
      expect(lazyStat.mode & 0o177777).toBe(eagerStat.mode & 0o177777);
      expect(lazyStat.size).toBe(eagerStat.size);
    }
    expect(readText(lazy, "/srv/bin/tool")).toBe("/new/");
    expect(readText(eager, "/srv/bin/tool")).toBe("/new/");
    expect(lazy.readlink("/srv/current")).toBe("bin/tool");
    expect(eager.readlink("/srv/current")).toBe("bin/tool");
    expect(lazy.lstat("/srv/bin/tool").ino).toBe(
      lazy.lstat("/srv/bin/tool-alias").ino,
    );
    expect(eager.lstat("/srv/bin/tool").ino).toBe(
      eager.lstat("/srv/bin/tool-alias").ino,
    );
  });

  it("fails before publication when transform input or output identity drifts", async () => {
    const fixture = transformedGenericTarTreeFixture();
    for (const field of ["input", "output"] as const) {
      const content = structuredClone(fixture.content);
      content.materialization.transforms[0]![field].sha256 = "0".repeat(64);
      const fs = createFs();
      fs.registerLazyTree(content, fixture.inventory, "/srv", fixture.activation);
      fs.setLazyFetcher(async () => new Response(fixture.payload));

      await expect(fs.preparePath("/srv/bin/tool"), field).rejects.toThrow(
        new RegExp(`transform .* ${field} SHA-256`),
      );
      expect(fs.isPathDeferred("/srv/bin/tool")).toBe(true);
    }

    const content = structuredClone(fixture.content);
    content.materialization.transforms[0]!.output.bytes = 4;
    const inventory = structuredClone(fixture.inventory);
    for (const entry of inventory) {
      if (entry.type === "file" || entry.type === "hardlink") entry.size = 4;
    }
    const fs = createFs();
    fs.registerLazyTree(content, inventory, "/srv", fixture.activation);
    fs.setLazyFetcher(async () => new Response(fixture.payload));
    await expect(fs.preparePath("/srv/bin/tool")).rejects.toThrow(
      /transform .* output byte count 5 does not match expected 4/,
    );
    expect(fs.isPathDeferred("/srv/bin/tool")).toBe(true);
  });

  it("preserves a replacement across transformed generation cleanup", async () => {
    const fixture = transformedGenericTarTreeFixture();
    const fs = createFs();
    fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/srv",
      fixture.activation,
    );
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    peer.unlink("/srv/bin/tool");
    const fd = peer.open("/srv/bin/tool", O_WRONLY_CREAT, 0o600);
    const replacement = encoder.encode("replacement\n");
    expect(peer.write(fd, replacement, null, replacement.byteLength))
      .toBe(replacement.byteLength);
    peer.close(fd);
    fs.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(fs.preparePath("/srv/bin/tool-alias")).resolves.toBe(true);
    expect(readText(fs, "/srv/bin/tool")).toBe("replacement\n");
    expect(readText(fs, "/srv/bin/tool-alias")).toBe("/new/");
    expect(fs.lstat("/srv/bin/tool").ino).not.toBe(
      fs.lstat("/srv/bin/tool-alias").ino,
    );
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("preserves a generic plan through image restore and rebase", async () => {
    const fixture = transformedGenericTarTreeFixture();
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/srv",
      fixture.activation,
    );
    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    expect(restored.exportLazyArchiveEntries()[0]!.content!.materialization)
      .toEqual(fixture.content.materialization);
    expect(JSON.stringify(restored.exportLazyArchiveEntries())).not.toMatch(
      /bottle|receipt|Cellar|keg|Formula/,
    );

    const rebased = restored.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(rebased.exportLazyArchiveEntries()[0]!.content!.materialization)
      .toEqual(fixture.content.materialization);
    rebased.setLazyFetcher(async () => new Response(fixture.payload));
    await expect(rebased.preparePath("/srv/bin/tool")).resolves.toBe(true);
    expect(readText(rebased, "/srv/bin/tool")).toBe("/new/");
  });

  it("commits an atomic activation group only after every tree validates", async () => {
    const bootstrap = tarTreeFixture("first-use", "bootstrap");
    const runtime = tarTreeFixture("first-use", "runtime");
    const fs = createFs();
    let repairRuntime = false;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/bootstrap.tar.gz")) {
        return new Response(bootstrap.payload);
      }
      return new Response(
        repairRuntime ? runtime.payload : bootstrap.payload,
      );
    });
    fs.setLazyFetcher(fetcher);
    await registerAtomicTrees(
      fs,
      "pkg:runtime",
      [bootstrap, runtime],
    );

    await expect(fs.preparePath("/bootstrap/tool")).rejects.toThrow(
      /All 1 lazy tree transports failed/,
    );
    // The first member was fetched and decoded successfully, but the failing
    // peer keeps both exact namespaces deferred and therefore retryable.
    expect(fs.isPathDeferred("/bootstrap/tool")).toBe(true);
    expect(fs.isPathDeferred("/runtime/tool")).toBe(true);

    repairRuntime = true;
    await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
    expect(readText(fs, "/bootstrap/tool")).toBe("payload");
    expect(readText(fs, "/runtime/tool")).toBe("payload");
    expect(fs.isPathDeferred("/bootstrap/tool")).toBe(false);
    expect(fs.isPathDeferred("/runtime/tool")).toBe(false);
  });

  it("rejects a mutated member instead of publishing a partial atomic tree", async () => {
    const bootstrap = tarTreeFixture("first-use", "bootstrap-mutated");
    const runtime = tarTreeFixture("first-use", "runtime-mutated");
    const payloads = new Map([
      [bootstrap.content.transports[0], bootstrap.payload],
      [runtime.content.transports[0], runtime.payload],
    ]);
    const fs = createFs();
    fs.setLazyFetcher(async (url) => new Response(payloads.get(url)!));
    await registerAtomicTrees(
      fs,
      "pkg:runtime-mutated",
      [bootstrap, runtime],
    );
    fs.unlink("/runtime-mutated/tool");

    await expect(
      fs.preparePath("/bootstrap-mutated/tool"),
    ).rejects.toThrow(/Lazy atomic tree changed at/);
    expect(fs.isPathDeferred("/bootstrap-mutated/tool")).toBe(true);
    expect(fs.isPathDeferred("/runtime-mutated/tool-hardlink")).toBe(true);
  });

  it("deduplicates concurrent entrypoints into one atomic activation", async () => {
    const bootstrap = tarTreeFixture("first-use", "bootstrap-concurrent");
    const runtime = tarTreeFixture("first-use", "runtime-concurrent");
    const payloads = new Map([
      [bootstrap.content.transports[0], bootstrap.payload],
      [runtime.content.transports[0], runtime.payload],
    ]);
    const fs = createFs();
    const fetcher = vi.fn(async (url: string) => {
      await Promise.resolve();
      return new Response(payloads.get(url)!);
    });
    fs.setLazyFetcher(fetcher);
    await registerAtomicTrees(
      fs,
      "pkg:runtime-concurrent",
      [bootstrap, runtime],
    );

    await expect(Promise.all([
      fs.preparePath("/bootstrap-concurrent/tool"),
      fs.preparePath("/runtime-concurrent/tool-hardlink"),
    ])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readText(fs, "/bootstrap-concurrent/tool")).toBe("payload");
    expect(readText(fs, "/runtime-concurrent/tool-hardlink")).toBe("payload");
  });

  it("round-trips atomic activation ownership through a VFS image", async () => {
    const bootstrap = tarTreeFixture("first-use", "bootstrap-roundtrip");
    const runtime = tarTreeFixture("first-use", "runtime-roundtrip");
    const source = createFs();
    await registerAtomicTrees(
      source,
      "pkg:runtime-roundtrip",
      [bootstrap, runtime],
    );
    const image = await source.saveImage();
    const restored = MemoryFileSystem.fromImage(image);
    expect(() => restored.exportLazyArchiveEntries()).toThrow(
      /not been cryptographically verified after import/,
    );
    expect(() => restored.rebaseToNewFileSystem(8 * 1024 * 1024)).toThrow(
      /not been cryptographically verified after import/,
    );
    await restored.sealLazyAtomicGroup(
      "pkg:runtime-roundtrip",
      [
        bootstrap.activation.capabilities[0]!,
        runtime.activation.capabilities[0]!,
      ],
    );
    expect(
      restored.rebaseToNewFileSystem(8 * 1024 * 1024)
        .exportLazyArchiveEntries(),
    ).toHaveLength(2);
    const serialized = restored.exportLazyArchiveEntries();
    expect(serialized).toHaveLength(2);
    expect(serialized.every(
      (entry) =>
        entry.kind === "kandelo-deferred-tree-v3" &&
        entry.activation?.atomicGroup?.id === "pkg:runtime-roundtrip" &&
        entry.activation.atomicGroup.expectedCount === 2,
    )).toBe(true);
    const payloads = new Map([
      [bootstrap.content.transports[0], bootstrap.payload],
      [runtime.content.transports[0], runtime.payload],
    ]);
    restored.setLazyFetcher(async (url) => new Response(payloads.get(url)!));

    await expect(
      restored.preparePath("/bootstrap-roundtrip/tool"),
    ).resolves.toBe(true);
    expect(restored.isPathDeferred("/runtime-roundtrip/tool")).toBe(false);
    expect(readText(restored, "/runtime-roundtrip/tool")).toBe("payload");
  });

  it("keeps structural guards usable after saving and exporting a live cohort", async () => {
    const regular = tarTreeFixture("first-use", "atomic-live-save");
    const symlink = symlinkTreeFixture();
    const fs = createFs();
    fs.registerLazyTree(
      regular.content,
      regular.inventory,
      "/",
      {
        ...regular.activation,
        atomicGroup: { id: "atomic:live-save", member: "regular" },
      },
    );
    fs.registerLazyTree(
      symlink.content,
      symlink.inventory,
      "/",
      {
        mode: "first-use",
        capabilities: ["test:live-save-symlink"],
        roots: ["/metadata"],
        atomicGroup: { id: "atomic:live-save", member: "symlink" },
      },
    );
    await fs.sealLazyAtomicGroup("atomic:live-save", ["regular", "symlink"]);
    await expect(fs.saveImage()).resolves.toBeInstanceOf(Uint8Array);
    expect(fs.exportLazyArchiveEntries()).toHaveLength(2);
    const payloads = new Map([
      [regular.content.transports[0], regular.payload],
      [symlink.content.transports[0], symlink.payload],
    ]);
    fs.setLazyFetcher(async (url) => new Response(payloads.get(url)!));

    await expect(fs.preparePath("/atomic-live-save/tool")).resolves.toBe(true);
    expect(readText(fs, "/atomic-live-save/tool")).toBe("payload");
    expect(fs.readlink("/metadata/runtime-link")).toBe("/runtime/target");
  });

  it("rewrites post-seal mirrors without changing byte identity", async () => {
    const first = tarTreeFixture("first-use", "atomic-rewrite-a");
    const second = tarTreeFixture("first-use", "atomic-rewrite-b");
    const fs = createFs();
    await registerAtomicTrees(fs, "atomic:rewrite", [first, second]);
    const sealed = fs.exportLazyArchiveEntries();
    const sealedMemberships = sealed.map((entry) =>
      entry.activation!.atomicGroup
    );

    fs.rewriteLazyArchiveUrls((url) =>
      url.replace("https://example.invalid/", "https://cdn.invalid/")
    );
    const rewritten = fs.exportLazyArchiveEntries();
    expect(rewritten.map((entry) => entry.activation!.atomicGroup))
      .toEqual(sealedMemberships);
    expect(rewritten.every((entry) =>
      entry.content!.transports[0]!.startsWith("https://cdn.invalid/")
    )).toBe(true);
    await expect(fs.saveImage()).resolves.toBeInstanceOf(Uint8Array);

    const payloads = new Map([
      ["https://cdn.invalid/atomic-rewrite-a.tar.gz", first.payload],
      ["https://cdn.invalid/atomic-rewrite-b.tar.gz", second.payload],
    ]);
    fs.setLazyFetcher(async (url) => new Response(payloads.get(url)!));
    await expect(fs.preparePath("/atomic-rewrite-a/tool")).resolves.toBe(true);
    expect(readText(fs, "/atomic-rewrite-a/tool")).toBe("payload");
    expect(readText(fs, "/atomic-rewrite-b/tool")).toBe("payload");
  });

  it("rejects an atomic image that omits a cohort record or pending alias", async () => {
    const first = tarTreeFixture("first-use", "atomic-seal-a");
    const second = tarTreeFixture("first-use", "atomic-seal-b");
    const fs = createFs();
    await registerAtomicTrees(fs, "atomic:sealed", [first, second]);
    const image = await fs.saveImage();
    const serialized = fs.exportLazyArchiveEntries();

    expect(() =>
      MemoryFileSystem.fromImage(
        replaceLazyArchiveMetadata(image, [serialized[0]!]),
      )
    ).toThrow(/has 1 of 2 members/);

    const missingAlias = structuredClone(serialized);
    missingAlias[1]!.entries = missingAlias[1]!.entries.filter(
      (entry) => !entry.vfsPath.endsWith("/tool-hardlink"),
    );
    expect(() =>
      MemoryFileSystem.fromImage(
        replaceLazyArchiveMetadata(image, missingAlias),
      )
    ).toThrow(/omits pending path .*tool-hardlink/);
  });

  it("rejects export and save after a peer writes an atomic stub", async () => {
    const first = tarTreeFixture("first-use", "atomic-export-write-a");
    const second = tarTreeFixture("first-use", "atomic-export-write-b");
    const owner = createFs();
    await registerAtomicTrees(owner, "atomic:export-write", [first, second]);
    const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
    const fd = peer.open(
      "/atomic-export-write-b/tool",
      O_WRONLY_CREAT,
      0o755,
    );
    peer.write(fd, encoder.encode("peer"), null, 4);
    peer.close(fd);

    expect(() => owner.exportLazyArchiveEntries()).toThrow(
      /changed identity before serialization|omits pending path .*atomic-export-write-b/,
    );
    let returnedImage: Uint8Array | undefined;
    await expect(
      owner.saveImage().then((image) => {
        returnedImage = image;
        return image;
      }),
    ).rejects.toThrow(
      /changed identity before serialization|omits pending path .*atomic-export-write-b/,
    );
    expect(returnedImage).toBeUndefined();
  });

  it("rejects export and save after a peer unlinks an atomic alias", async () => {
    const first = tarTreeFixture("first-use", "atomic-export-unlink-a");
    const second = tarTreeFixture("first-use", "atomic-export-unlink-b");
    const owner = createFs();
    await registerAtomicTrees(owner, "atomic:export-unlink", [first, second]);
    const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
    peer.unlink("/atomic-export-unlink-b/tool-hardlink");

    expect(() => owner.exportLazyArchiveEntries()).toThrow(
      /changed data or undeclared aliases|omits pending path .*tool-hardlink/,
    );
    let returnedImage: Uint8Array | undefined;
    await expect(
      owner.saveImage().then((image) => {
        returnedImage = image;
        return image;
      }),
    ).rejects.toThrow(
      /changed data or undeclared aliases|omits pending path .*tool-hardlink/,
    );
    expect(returnedImage).toBeUndefined();
  });

  it("distinguishes local deletion tombstones from peer removal of every alias", async () => {
    const first = tarTreeFixture("first-use", "atomic-export-remove-a");
    const second = tarTreeFixture("first-use", "atomic-export-remove-b");
    const owner = createFs();
    await registerAtomicTrees(owner, "atomic:export-remove", [first, second]);
    const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
    peer.unlink("/atomic-export-remove-b/tool-hardlink");
    peer.unlink("/atomic-export-remove-b/tool");

    expect(() => owner.exportLazyArchiveEntries()).toThrow(
      /omits pending path .*atomic-export-remove-b|missing from the captured filesystem state/,
    );
    await expect(owner.saveImage()).rejects.toThrow(
      /omits pending path .*atomic-export-remove-b|missing from the captured filesystem state/,
    );
  });

  it("rejects export and save after a peer removes a structural symlink", async () => {
    const regular = tarTreeFixture("first-use", "atomic-export-symlink");
    const symlink = symlinkTreeFixture();
    const owner = createFs();
    owner.registerLazyTree(
      regular.content,
      regular.inventory,
      "/",
      {
        ...regular.activation,
        atomicGroup: {
          id: "atomic:export-symlink",
          member: "regular",
        },
      },
    );
    owner.registerLazyTree(
      symlink.content,
      symlink.inventory,
      "/",
      {
        mode: "first-use",
        capabilities: ["test:export-symlink"],
        roots: ["/metadata"],
        atomicGroup: {
          id: "atomic:export-symlink",
          member: "symlink",
        },
      },
    );
    await owner.sealLazyAtomicGroup(
      "atomic:export-symlink",
      ["regular", "symlink"],
    );
    const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
    peer.unlink("/metadata/runtime-link");

    expect(() => owner.exportLazyArchiveEntries()).toThrow(
      /namespace entry .*runtime-link.*missing from the captured filesystem state/,
    );
    let returnedImage: Uint8Array | undefined;
    await expect(
      owner.saveImage().then((image) => {
        returnedImage = image;
        return image;
      }),
    ).rejects.toThrow(
      /namespace entry .*runtime-link.*missing from the captured filesystem state/,
    );
    expect(returnedImage).toBeUndefined();
  });

  it.each([
    ["directory", "/atomic-export-mode-b"],
    ["regular stub", "/atomic-export-mode-b/tool"],
  ])(
    "rejects export and save after a peer changes an atomic %s mode",
    async (_kind, path) => {
      const first = tarTreeFixture("first-use", "atomic-export-mode-a");
      const second = tarTreeFixture("first-use", "atomic-export-mode-b");
      const owner = createFs();
      await registerAtomicTrees(owner, "atomic:export-mode", [first, second]);
      const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
      peer.chmod(path, 0o700);

      expect(() => owner.exportLazyArchiveEntries()).toThrow(
        /namespace entry .*disagrees with its captured type or mode/,
      );
      let returnedImage: Uint8Array | undefined;
      await expect(
        owner.saveImage().then((image) => {
          returnedImage = image;
          return image;
        }),
      ).rejects.toThrow(
        /namespace entry .*disagrees with its captured type or mode/,
      );
      expect(returnedImage).toBeUndefined();
    },
  );

  it("rejects export and save after a peer adds an undeclared atomic alias", async () => {
    const first = tarTreeFixture("first-use", "atomic-export-alias-a");
    const second = tarTreeFixture("first-use", "atomic-export-alias-b");
    const owner = createFs();
    await registerAtomicTrees(owner, "atomic:export-alias", [first, second]);
    const peer = MemoryFileSystem.fromExisting(owner.sharedBuffer);
    peer.link("/atomic-export-alias-b/tool", "/undeclared-tool-alias");

    expect(() => owner.exportLazyArchiveEntries()).toThrow(
      /inventory|undeclared aliases/,
    );
    let returnedImage: Uint8Array | undefined;
    await expect(
      owner.saveImage().then((image) => {
        returnedImage = image;
        return image;
      }),
    ).rejects.toThrow(/inventory|undeclared aliases/);
    expect(returnedImage).toBeUndefined();
  });

  it("requires an explicit exact seal and binds each member descriptor", async () => {
    const first = tarTreeFixture("first-use", "atomic-bind-a");
    const second = tarTreeFixture("first-use", "atomic-bind-b");
    const fs = createFs();
    const groups = [first, second].map((fixture) =>
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        {
          ...fixture.activation,
          atomicGroup: {
            id: "atomic:binding",
            member: fixture.activation.capabilities[0]!,
          },
        },
      )
    );
    await expect(fs.saveImage()).rejects.toThrow(/must be sealed/);
    await expect(
      fs.sealLazyAtomicGroup("atomic:binding", [
        first.activation.capabilities[0]!,
      ]),
    ).rejects.toThrow(/members differ from its seal/);
    await fs.sealLazyAtomicGroup("atomic:binding", [
      first.activation.capabilities[0]!,
      second.activation.capabilities[0]!,
    ]);
    groups[1]!.inventory![0]!.mode = 0o700;
    const fetcher = vi.fn(async () => new Response(first.payload));
    fs.setLazyFetcher(fetcher);

    await expect(
      fs.preparePath("/atomic-bind-a/tool"),
    ).rejects.toThrow(/changed after sealing/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(fs.isPathDeferred("/atomic-bind-a/tool")).toBe(true);
    expect(fs.isPathDeferred("/atomic-bind-b/tool")).toBe(true);
  });

  it.each([
    [
      "capability array",
      (group: LazyTreeGroup) => {
        group.activation!.capabilities[0] = "test:mutated-capability";
      },
    ],
    [
      "activation root array",
      (group: LazyTreeGroup) => {
        group.activation!.roots[0] = "/atomic-seal-mutation/tool-hardlink";
      },
    ],
    [
      "nested atomic membership",
      (group: LazyTreeGroup) => {
        group.activation!.atomicGroup!.member = "mutated-member";
      },
    ],
    [
      "nested atomic seal digest",
      (group: LazyTreeGroup) => {
        group.activation!.atomicGroup!.cohortSha256 = "f".repeat(64);
      },
    ],
  ] as const)(
    "rejects export and save after post-seal mutation of the %s",
    async (_label, mutate) => {
      const fixture = tarTreeFixture(
        "first-use",
        "atomic-seal-mutation",
      );
      const fs = createFs();
      const group = fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        {
          ...fixture.activation,
          atomicGroup: {
            id: "atomic:seal-mutation",
            member: "runtime",
          },
        },
      );
      await fs.sealLazyAtomicGroup("atomic:seal-mutation", ["runtime"]);
      mutate(group);

      expect(() => fs.exportLazyArchiveEntries()).toThrow(
        /activation member runtime changed after sealing/,
      );
      await expect(fs.saveImage()).rejects.toThrow(
        /activation member runtime changed after sealing/,
      );
    },
  );

  it("cryptographically revalidates an imported cohort before saving it", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-imported-seal");
    const source = createFs();
    await registerAtomicTrees(source, "atomic:imported-seal", [fixture]);
    const image = await source.saveImage();
    const tampered = structuredClone(source.exportLazyArchiveEntries());
    tampered[0]!.activation!.capabilities[0] = "test:tampered-after-publication";
    const restored = MemoryFileSystem.fromImage(
      replaceLazyArchiveMetadata(image, tampered),
    );

    expect(() => restored.exportLazyArchiveEntries()).toThrow(
      /not been cryptographically verified after import/,
    );
    expect(() => restored.rebaseToNewFileSystem(8 * 1024 * 1024)).toThrow(
      /not been cryptographically verified after import/,
    );
    await expect(restored.saveImage()).rejects.toThrow(
      /activation member .* changed after sealing/,
    );
  });

  it("explicitly verifies imported v3 seals without filesystem or fetch side effects", async () => {
    const first = tarTreeFixture("first-use", "atomic-explicit-first");
    const second = tarTreeFixture("first-use", "atomic-explicit-second");
    const source = createFs();
    await registerAtomicTrees(
      source,
      "atomic:explicit-import",
      [first, second],
    );
    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async () => new Response(first.payload));
    restored.setLazyFetcher(fetcher);

    expectImportedAtomicInspectionBlocked(restored);
    expect(restored.isPathDeferred("/atomic-explicit-first/tool")).toBe(true);
    expect(restored.isPathDeferred("/atomic-explicit-second/tool")).toBe(true);
    const sharedBytesBefore = createHash("sha256")
      .update(new Uint8Array(restored.sharedBuffer))
      .digest("hex");
    const saveSpy = vi.spyOn(restored, "saveImage");
    const exportSpy = vi.spyOn(restored, "exportLazyArchiveEntries");
    const rebaseSpy = vi.spyOn(restored, "rebaseToNewFileSystem");

    await restored.verifyImportedLazyAtomicGroupSeals();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(exportSpy).not.toHaveBeenCalled();
    expect(rebaseSpy).not.toHaveBeenCalled();
    saveSpy.mockRestore();
    exportSpy.mockRestore();
    rebaseSpy.mockRestore();
    expect(
      createHash("sha256")
        .update(new Uint8Array(restored.sharedBuffer))
        .digest("hex"),
    ).toBe(sharedBytesBefore);
    expect(fetcher).not.toHaveBeenCalled();
    expect(restored.isPathDeferred("/atomic-explicit-first/tool")).toBe(true);
    expect(restored.isPathDeferred("/atomic-explicit-second/tool")).toBe(true);
    expect(restored.exportLazyArchiveEntries()).toHaveLength(2);
    expect(restored.pendingDeferredTreeUsage().groups).toBe(2);

    const rebased = restored.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(rebased.exportLazyArchiveEntries()).toHaveLength(2);
    expect(rebased.isPathDeferred("/atomic-explicit-first/tool")).toBe(true);
    expect(rebased.isPathDeferred("/atomic-explicit-second/tool")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects forged imported member and cohort hashes and keeps inspection blocked", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-forged-seal");
    const source = createFs();
    await registerAtomicTrees(source, "atomic:forged-seal", [fixture]);
    const image = await source.saveImage();
    const serialized = source.exportLazyArchiveEntries();
    const forgeries = [
      {
        label: "member",
        expected: /activation member .* changed after sealing/,
        mutate(entries: typeof serialized): void {
          entries[0]!.activation!.atomicGroup!.descriptorSha256 = "f".repeat(64);
        },
      },
      {
        label: "cohort",
        expected: /activation group .* differs from its seal/,
        mutate(entries: typeof serialized): void {
          entries[0]!.activation!.atomicGroup!.cohortSha256 = "f".repeat(64);
        },
      },
    ];

    for (const forgery of forgeries) {
      const forged = structuredClone(serialized);
      forgery.mutate(forged);
      const restored = MemoryFileSystem.fromImage(
        replaceLazyArchiveMetadata(image, forged),
      );
      const fetcher = vi.fn(async () => new Response(fixture.payload));
      restored.setLazyFetcher(fetcher);

      expectImportedAtomicInspectionBlocked(restored);
      await expect(
        restored.verifyImportedLazyAtomicGroupSeals(),
        forgery.label,
      ).rejects.toThrow(forgery.expected);
      expectImportedAtomicInspectionBlocked(restored);
      await expect(
        restored.verifyImportedLazyAtomicGroupSeals(),
        `${forgery.label} retry`,
      ).rejects.toThrow(forgery.expected);
      expect(restored.isPathDeferred("/atomic-forged-seal/tool")).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["plan", (group: LazyTreeGroup) => {
      group.content!.materialization = {
        ...group.content!.materialization!,
        assertions: [{ sourcePath: "bin/tool", bytesHex: "00" }],
      };
    }],
    ["assertions", (group: LazyTreeGroup) => {
      (group.content!.materialization!.assertions[0] as { bytesHex: string })
        .bytesHex = "00";
    }],
    ["recipes", (group: LazyTreeGroup) => {
      (group.content!.materialization!.recipes[0]!.replacements[0] as {
        replacementHex: string;
      }).replacementHex = encodeMaterializationBytes(encoder.encode("/evil/"));
    }],
    ["transforms", (group: LazyTreeGroup) => {
      (group.content!.materialization!.transforms[0]!.output as { bytes: number })
        .bytes = 1;
    }],
    ["source inventory", (group: LazyTreeGroup) => {
      group.content!.source!.entries[1]!.sourcePath = "bin/substitute";
    }],
    ["registration inventory", (group: LazyTreeGroup) => {
      group.inventory!.find((entry) => entry.type === "file")!.sourcePath =
        "bin/substitute";
    }],
  ] as const)(
    "materializes from its private snapshot after exposed %s mutation",
    async (_label, mutate) => {
      const fixture = transformedGenericTarTreeFixture();
      const fs = createFs();
      const group = fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/srv",
        fixture.activation,
      );
      mutate(group);
      fs.setLazyFetcher(async () => new Response(fixture.payload));

      await expect(fs.preparePath("/srv/bin/tool")).resolves.toBe(true);
      expect(readText(fs, "/srv/bin/tool")).toBe("/new/");
    },
  );

  it("exports, restores, and rebases the private ordinary-tree snapshot", async () => {
    const fixture = transformedGenericTarTreeFixture();
    const fs = createFs();
    const group = fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/srv",
      fixture.activation,
    );
    (group.content!.materialization!.assertions[0] as { bytesHex: string })
      .bytesHex = "00";
    group.content!.source!.entries[1]!.sourcePath = "bin/substitute";
    group.inventory!.find((entry) => entry.type === "file")!.sourcePath =
      "bin/substitute";

    const exported = fs.exportLazyArchiveEntries();
    expect(exported[0]!.content!.materialization).toEqual(
      fixture.content.materialization,
    );
    expect(exported[0]!.content!.source).toEqual(fixture.content.source);
    expect(exported[0]!.inventory).toEqual(fixture.inventory);

    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    const rebased = fs.rebaseToNewFileSystem(8 * 1024 * 1024);
    for (const candidate of [fs, restored, rebased]) {
      candidate.setLazyFetcher(async () => new Response(fixture.payload));
      await expect(candidate.preparePath("/srv/bin/tool")).resolves.toBe(true);
      expect(readText(candidate, "/srv/bin/tool")).toBe("/new/");
    }
  });

  it("does not let an ordinary public archivePath substitute ZIP members", async () => {
    const fixture = zipTreeFixture("edge", [
      ["a", "alpha"],
      ["b", "bravo"],
    ]);
    const fs = createFs();
    const group = fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    group.entries.get("/edge/a")!.archivePath =
      group.entries.get("/edge/b")!.archivePath;
    fs.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(fs.preparePath("/edge/a")).resolves.toBe(true);
    expect(readText(fs, "/edge/a")).toBe("alpha");
    expect(readText(fs, "/edge/b")).toBe("bravo");
  });

  const ordinaryEntryAuthorityMutations: readonly (readonly [
    label: string,
    mutate: (
      group: LazyTreeGroup,
      a: LazyArchiveFileEntry,
      b: LazyArchiveFileEntry,
    ) => void,
  ])[] = [
    ["archivePath", (_group, a, b) => a.archivePath = b.archivePath],
    ["destination path", (group, a) => {
      group.entries.delete("/edge/a");
      group.entries.set("/edge/redirected", a);
    }],
    ["entry presence", (group) => group.entries.delete("/edge/a")],
    ["inode number", (_group, a, b) => a.ino = b.ino],
    ["inode generation", (_group, a) => a.generation = 999_999],
    ["data sequence", (_group, a) => {
      a.dataSequence = (a.dataSequence ?? 0) + 1;
    }],
    ["size", (_group, a) => a.size = 0],
    ["symlink kind", (_group, a) => a.isSymlink = true],
    ["deletion state", (_group, a) => a.deleted = true],
    ["materialization state", (_group, a) => a.materialized = true],
    ["sourcePath", (_group, a, b) => a.sourcePath = b.sourcePath],
    ["entry type", (_group, a) => a.type = "hardlink"],
    ["inode group", (_group, a, b) => a.inodeGroup = b.inodeGroup],
    ["link target", (_group, a, b) => a.target = b.sourcePath],
    ["tree materialization state", (group) => group.materialized = true],
    ["inventory mode", (group) => {
      group.inventory!.find((entry) => entry.vfsPath === "/edge/a")!.mode = 0;
    }],
  ];

  it.each(ordinaryEntryAuthorityMutations)(
    "keeps ordinary %s mutation out of entry authority",
    async (_label, mutate) => {
      const fixture = zipTreeFixture("edge", [
        ["a", "alpha"],
        ["b", "bravo"],
      ]);
      const register = () => {
        const fs = createFs();
        const group = fs.registerLazyTree(
          fixture.content,
          fixture.inventory,
          "/",
          fixture.activation,
        );
        const a = group.entries.get("/edge/a")!;
        const b = group.entries.get("/edge/b")!;
        const expectedIdentity = {
          ino: a.ino,
          generation: a.generation,
          dataSequence: a.dataSequence,
        };
        mutate(group, a, b);
        return { fs, group, expectedIdentity };
      };

      const materialized = register();
      materialized.fs.setLazyFetcher(
        async () => new Response(fixture.payload),
      );
      await expect(materialized.fs.preparePath("/edge/a")).resolves.toBe(true);
      expect(readText(materialized.fs, "/edge/a")).toBe("alpha");
      expect(readText(materialized.fs, "/edge/b")).toBe("bravo");
      expect(materialized.fs.stat("/edge/a").mode & 0o7777).toBe(0o755);

      const exported = register();
      const serialized = exported.fs.exportLazyArchiveEntries()[0]!;
      const serializedA = serialized.entries.find(
        (entry) => entry.vfsPath === "/edge/a",
      )!;
      expect(serializedA).toMatchObject({
        vfsPath: "/edge/a",
        ...exported.expectedIdentity,
        size: 5,
        isSymlink: false,
        deleted: false,
        materialized: false,
        archivePath: "edge/a",
        sourcePath: "edge/a",
        type: "file",
        inodeGroup: "edge:a",
      });
      expect(serializedA.target).toBeUndefined();
      expect(serialized.inventory!.find(
        (entry) => entry.vfsPath === "/edge/a",
      )!.mode).toBe(0o755);
    },
  );

  it("keeps authorized rename, link, and chmod live during first use", async () => {
    const fixture = zipTreeFixture("edge", [
      ["a", "alpha"],
      ["b", "bravo"],
    ]);
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    fs.rename("/edge/a", "/edge/moved");
    fs.link("/edge/moved", "/edge/alias");
    fs.chmod("/edge/moved", 0o640);
    fs.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(fs.preparePath("/edge/alias")).resolves.toBe(true);
    expect(readText(fs, "/edge/moved")).toBe("alpha");
    expect(readText(fs, "/edge/alias")).toBe("alpha");
    expect(readText(fs, "/edge/b")).toBe("bravo");
    expect(fs.stat("/edge/moved").mode & 0o7777).toBe(0o640);
  });

  it("preserves a replacement inode after authorized unlink", async () => {
    const fixture = zipTreeFixture("edge", [
      ["a", "alpha"],
      ["b", "bravo"],
    ]);
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    fs.unlink("/edge/a");
    fs.createFileWithOwner("/edge/a", 0o600, 0, 0, encoder.encode("local"));
    fs.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(fs.preparePath("/edge/b")).resolves.toBe(true);
    expect(readText(fs, "/edge/a")).toBe("local");
    expect(readText(fs, "/edge/b")).toBe("bravo");
  });

  it("restores and rebases an authorized ordinary-tree rename", async () => {
    const fixture = zipTreeFixture("edge", [
      ["a", "alpha"],
      ["b", "bravo"],
    ]);
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    fs.rename("/edge/a", "/edge/moved");

    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    const rebased = fs.rebaseToNewFileSystem(8 * 1024 * 1024);
    for (const candidate of [fs, restored, rebased]) {
      candidate.setLazyFetcher(async () => new Response(fixture.payload));
      await expect(candidate.preparePath("/edge/moved")).resolves.toBe(true);
      expect(readText(candidate, "/edge/moved")).toBe("alpha");
      expect(readText(candidate, "/edge/b")).toBe("bravo");
    }
  });

  it("publishes archive registrations only after their imported seals verify", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-registration");
    const source = createFs();
    await registerAtomicTrees(source, "atomic:registration", [fixture]);
    const image = await source.saveImage();
    const serialized = source.exportLazyArchiveEntries();
    const bareImage = replaceLazyArchiveMetadata(image, []);

    const accepted = MemoryFileSystem.fromImage(bareImage);
    await accepted.importVerifiedLazyArchiveEntries(
      structuredClone(serialized),
    );
    expect(accepted.exportLazyArchiveEntries()).toEqual(serialized);

    for (const field of ["descriptorSha256", "cohortSha256"] as const) {
      const forged = structuredClone(serialized);
      forged[0]!.activation!.atomicGroup![field] = "f".repeat(64);
      const rejected = MemoryFileSystem.fromImage(bareImage);

      await expect(
        rejected.importVerifiedLazyArchiveEntries(forged),
      ).rejects.toThrow(
        field === "descriptorSha256"
          ? /activation member .* changed after sealing/
          : /activation group .* differs from its seal/,
      );
      // WHY: a failed async trust check must not leave its metadata visible in
      // the live filesystem even though the registration request failed.
      expect(rejected.exportLazyArchiveEntries()).toEqual([]);
    }
  });

  it("requires the async verified importer for sealed registrations", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-safe-import-api");
    const source = createFs();
    await registerAtomicTrees(source, "atomic:safe-import-api", [fixture]);
    const serialized = source.exportLazyArchiveEntries();
    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);

    expect(() =>
      peer.importLazyArchiveEntries(structuredClone(serialized))
    ).toThrow(/require importVerifiedLazyArchiveEntries/);
    expect(peer.exportLazyArchiveEntries()).toEqual([]);

    await expect(
      peer.importVerifiedLazyArchiveEntries(structuredClone(serialized)),
    ).resolves.toBeUndefined();
    expect(peer.exportLazyArchiveEntries()).toEqual(serialized);
  });

  it("snapshots caller-owned registrations before async seal verification", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-import-snapshot");
    const source = createFs();
    await registerAtomicTrees(source, "atomic:import-snapshot", [fixture]);
    const image = await source.saveImage();
    const serialized = source.exportLazyArchiveEntries();
    const target = MemoryFileSystem.fromImage(
      replaceLazyArchiveMetadata(image, []),
    );
    const callerOwned = structuredClone(serialized);
    const digestGate = gatedSha256Digests();
    try {
      const importing = target.importVerifiedLazyArchiveEntries(callerOwned);
      void importing.catch(() => {});
      await vi.waitFor(() => expect(digestGate.spy).toHaveBeenCalledTimes(1));

      // WHY: the caller still owns this object while SHA-256 is awaiting.
      // Publishing this replacement would authenticate one value and install
      // another after the trust boundary completes.
      callerOwned[0]!.activation!.capabilities[0] =
        "test:caller-owned-mutation";
      expect(callerOwned).not.toEqual(serialized);

      digestGate.release();
      await expect(importing).resolves.toBeUndefined();
      expect(target.exportLazyArchiveEntries()).toEqual(serialized);
      expect(
        target.exportLazyArchiveEntries()[0]!.activation!.capabilities,
      ).not.toContain("test:caller-owned-mutation");
    } finally {
      digestGate.release();
      digestGate.spy.mockRestore();
    }
  });

  it("keeps explicit seal verification idempotent for a locally sealed cohort", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-local-seal");
    const fs = createFs();
    await registerAtomicTrees(fs, "atomic:local-seal", [fixture]);
    const sealed = fs.exportLazyArchiveEntries();
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    fs.setLazyFetcher(fetcher);

    await fs.verifyImportedLazyAtomicGroupSeals();
    await fs.verifyImportedLazyAtomicGroupSeals();

    expect(fs.exportLazyArchiveEntries()).toEqual(sealed);
    expect(fs.pendingDeferredTreeUsage().groups).toBe(1);
    expect(
      fs.rebaseToNewFileSystem(8 * 1024 * 1024)
        .exportLazyArchiveEntries(),
    ).toEqual(sealed);
    expect(fs.isPathDeferred("/atomic-local-seal/tool")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lets explicit verification establish the seal proof that activation joins", async () => {
    const fixture = await importedAtomicPair("atomic:verify-wins", "verify-wins");
    const digestGate = gatedSha256Digests();
    const fetchGate = deferredGate();
    const fetcher = vi.fn(async (url: string) => {
      await fetchGate.promise;
      return new Response(fixture.payloads.get(url)!);
    });
    fixture.fs.setLazyFetcher(fetcher);
    try {
      const verification =
        fixture.fs.verifyImportedLazyAtomicGroupSeals();
      await vi.waitFor(() => expect(digestGate.spy).toHaveBeenCalledTimes(1));
      const activation = fixture.fs.preparePath(fixture.paths.first);
      void activation.catch(() => {});
      await Promise.resolve();
      expect(digestGate.spy).toHaveBeenCalledTimes(1);

      digestGate.release();
      await expect(verification).resolves.toBeUndefined();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(digestGate.spy).toHaveBeenCalledTimes(3);
      expect(fixture.fs.isPathDeferred(fixture.paths.first)).toBe(true);
      expect(fixture.fs.isPathDeferred(fixture.paths.second)).toBe(true);

      fetchGate.resolve();
      await expect(activation).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(digestGate.spy).toHaveBeenCalledTimes(5);
      expect(fixture.fs.isPathDeferred(fixture.paths.first)).toBe(false);
      expect(fixture.fs.isPathDeferred(fixture.paths.second)).toBe(false);
    } finally {
      digestGate.release();
      fetchGate.resolve();
      digestGate.spy.mockRestore();
    }
  });

  it("lets verification join activation's one seal proof before transport completes", async () => {
    const fixture = await importedAtomicPair(
      "atomic:activation-wins",
      "activation-wins",
    );
    const digestGate = gatedSha256Digests();
    const fetchGate = deferredGate();
    const fetcher = vi.fn(async (url: string) => {
      await fetchGate.promise;
      return new Response(fixture.payloads.get(url)!);
    });
    fixture.fs.setLazyFetcher(fetcher);
    try {
      const activation = fixture.fs.preparePath(fixture.paths.first);
      void activation.catch(() => {});
      await vi.waitFor(() => expect(digestGate.spy).toHaveBeenCalledTimes(1));
      const verification =
        fixture.fs.verifyImportedLazyAtomicGroupSeals();
      await Promise.resolve();
      expect(digestGate.spy).toHaveBeenCalledTimes(1);

      digestGate.release();
      await expect(verification).resolves.toBeUndefined();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(digestGate.spy).toHaveBeenCalledTimes(3);
      expect(fixture.fs.exportLazyArchiveEntries()).toHaveLength(2);

      fetchGate.resolve();
      await expect(activation).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(digestGate.spy).toHaveBeenCalledTimes(5);
    } finally {
      digestGate.release();
      fetchGate.resolve();
      digestGate.spy.mockRestore();
    }
  });

  it("rejects joined verification and activation after persistent mutation or unlink", async () => {
    for (const fault of ["unlink", "mutation"] as const) {
      const fixture = await importedAtomicPair(
        `atomic:joined-${fault}`,
        `joined-${fault}`,
      );
      const digestGate = gatedSha256Digests();
      const fetcher = vi.fn(async (url: string) =>
        new Response(fixture.payloads.get(url)!));
      fixture.fs.setLazyFetcher(fetcher);
      try {
        const verification =
          fixture.fs.verifyImportedLazyAtomicGroupSeals();
        void verification.catch(() => {});
        await vi.waitFor(() => expect(digestGate.spy).toHaveBeenCalledTimes(1));
        const activation = fixture.fs.preparePath(fixture.paths.first);
        void activation.catch(() => {});
        await Promise.resolve();
        expect(digestGate.spy).toHaveBeenCalledTimes(1);

        if (fault === "mutation") {
          importedAtomicGroups(fixture.fs)[0]!.activation!.capabilities[0] =
            "test:persistent-mutation";
        } else {
          fixture.fs.unlink(`${fixture.roots.first}/tool-hardlink`);
        }
        digestGate.release();

        await expect(verification).rejects.toThrow(/changed/);
        await expect(activation).rejects.toThrow(/changed/);
        expect(digestGate.spy).toHaveBeenCalledTimes(3);
        expect(fetcher).not.toHaveBeenCalled();
        expect(() => fixture.fs.exportLazyArchiveEntries()).toThrow();
      } finally {
        digestGate.release();
        digestGate.spy.mockRestore();
      }
    }
  });

  it("keeps a verified seal reusable after transport failure leaves activation retryable", async () => {
    const fixture = await importedAtomicPair(
      "atomic:verified-fetch-failure",
      "verified-fetch-failure",
    );
    const digestGate = gatedSha256Digests();
    let failFetch = true;
    const fetcher = vi.fn(async (url: string) =>
      failFetch
        ? new Response("unavailable", { status: 404 })
        : new Response(fixture.payloads.get(url)!));
    fixture.fs.setLazyFetcher(fetcher);
    try {
      const activation = fixture.fs.preparePath(fixture.paths.first);
      void activation.catch(() => {});
      await vi.waitFor(() => expect(digestGate.spy).toHaveBeenCalledTimes(1));
      const verification =
        fixture.fs.verifyImportedLazyAtomicGroupSeals();
      digestGate.release();

      await expect(verification).resolves.toBeUndefined();
      await expect(activation).rejects.toThrow(
        /All 1 lazy tree transports failed/,
      );
      expect(digestGate.spy).toHaveBeenCalledTimes(3);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fixture.fs.exportLazyArchiveEntries()).toHaveLength(2);
      expect(fixture.fs.pendingDeferredTreeUsage().groups).toBe(2);
      expect(fixture.fs.isPathDeferred(fixture.paths.first)).toBe(true);
      expect(fixture.fs.isPathDeferred(fixture.paths.second)).toBe(true);

      failFetch = false;
      await expect(
        fixture.fs.preparePath(fixture.paths.second),
      ).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(4);
      // Three seal digests were shared by both initial callers. The retry only
      // hashes the two successfully fetched payloads.
      expect(digestGate.spy).toHaveBeenCalledTimes(5);
      expect(fixture.fs.isPathDeferred(fixture.paths.first)).toBe(false);
      expect(fixture.fs.isPathDeferred(fixture.paths.second)).toBe(false);
    } finally {
      digestGate.release();
      digestGate.spy.mockRestore();
    }
  });

  it("keeps sealed integrity authoritative through a fetch-time substitution", async () => {
    const trusted = zipTreeFixture(
      "atomic-integrity",
      [["tool", "payload"]],
    );
    const substituted = zipTreeFixture(
      "atomic-integrity",
      [["tool", "eviload"]],
    );
    expect(substituted.payload.byteLength).toBe(trusted.payload.byteLength);
    const fs = createFs();
    const group = fs.registerLazyTree(
      trusted.content,
      trusted.inventory,
      "/",
      {
        ...trusted.activation,
        atomicGroup: { id: "atomic:integrity", member: "runtime" },
      },
    );
    await fs.sealLazyAtomicGroup("atomic:integrity", ["runtime"]);

    let substituteIntegrity = false;
    const trustedIntegrity = group.integrity!;
    group.integrity = {
      get sha256() {
        if (!substituteIntegrity) return trustedIntegrity.sha256;
        // A vulnerable fetch reads this caller-reachable replacement and then
        // observes the restored trusted digest on later public-state checks.
        substituteIntegrity = false;
        return substituted.content.sha256;
      },
      get bytes() {
        return trustedIntegrity.bytes;
      },
    };
    fs.setLazyFetcher(async () => {
      substituteIntegrity = true;
      return new Response(substituted.payload);
    });

    await expect(fs.preparePath("/atomic-integrity/tool")).rejects.toThrow(
      /SHA-256 .* does not match expected/,
    );
    substituteIntegrity = false;
    expect(fs.isPathDeferred("/atomic-integrity/tool")).toBe(true);
    expect(MemoryFileSystem.fromExisting(fs.sharedBuffer)
      .lstat("/atomic-integrity/tool").size).toBe(0);
  });

  it("ignores a mutate-use-restore mapping substitution during decode", async () => {
    const fixture = zipTreeFixture(
      "atomic-mapping",
      [
        ["trusted", "good"],
        ["substitute", "malicious"],
      ],
    );
    const fs = createFs();
    const group = fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      {
        ...fixture.activation,
        atomicGroup: { id: "atomic:mapping", member: "runtime" },
      },
    );
    await fs.sealLazyAtomicGroup("atomic:mapping", ["runtime"]);

    const trustedPath = "/atomic-mapping/trusted";
    const substitutePath = "/atomic-mapping/substitute";
    const canonicalEntries = group.entries;
    let armed = false;
    class TransientMappingEntries
      extends Map<string, LazyArchiveFileEntry> {
      override *[Symbol.iterator](): MapIterator<
        [string, LazyArchiveFileEntry]
      > {
        const trusted = super.get(trustedPath)!;
        const substitute = super.get(substitutePath)!;
        const savedArchivePath = trusted.archivePath;
        const savedSize = trusted.size;
        if (armed) {
          armed = false;
          trusted.archivePath = substitute.archivePath;
          trusted.size = substitute.size;
        }
        try {
          yield* super[Symbol.iterator]();
        } finally {
          trusted.archivePath = savedArchivePath;
          trusted.size = savedSize;
        }
      }
    }
    group.entries = new TransientMappingEntries(canonicalEntries);
    fs.setLazyFetcher(async () => {
      // The public map mutates only when decode/preflight iterates it, then
      // restores itself before the post-await seal check.
      armed = true;
      return new Response(fixture.payload);
    });

    await expect(fs.preparePath(trustedPath)).resolves.toBe(true);
    expect(readText(fs, trustedPath)).toBe("good");
    expect(readText(fs, substitutePath)).toBe("malicious");
  });

  it("does not let public materialized flags omit a sealed pending member", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-public-state");
    const fs = createFs();
    const group = fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      {
        ...fixture.activation,
        atomicGroup: { id: "atomic:public-state", member: "runtime" },
      },
    );
    await fs.sealLazyAtomicGroup("atomic:public-state", ["runtime"]);
    for (const entry of group.entries.values()) entry.materialized = true;
    group.materialized = true;

    expect(() => fs.exportLazyArchiveEntries()).toThrow(
      /changed after sealing/,
    );
    await expect(fs.saveImage()).rejects.toThrow(/changed after sealing/);
  });

  it("rejects a hardlink alias removed by a peer while fetching the cohort", async () => {
    const first = tarTreeFixture("first-use", "atomic-peer-a");
    const second = tarTreeFixture("first-use", "atomic-peer-b");
    const payloads = new Map([
      [first.content.transports[0], first.payload],
      [second.content.transports[0], second.payload],
    ]);
    const fs = createFs();
    await registerAtomicTrees(fs, "atomic:peer-alias", [first, second]);
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let started = 0;
    fs.setLazyFetcher(async (url) => {
      started += 1;
      await fetchGate;
      return new Response(payloads.get(url)!);
    });
    const activation = fs.preparePath("/atomic-peer-a/tool");
    await vi.waitFor(() => expect(started).toBe(2));
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    peer.unlink("/atomic-peer-b/tool-hardlink");
    releaseFetch();

    await expect(activation).rejects.toThrow(/changed before commit/);
    expect(fs.isPathDeferred("/atomic-peer-a/tool")).toBe(true);
    expect(fs.isPathDeferred("/atomic-peer-b/tool")).toBe(true);
    expect(() => peer.lstat("/atomic-peer-b/tool-hardlink")).toThrow();
    expect(peer.lstat("/atomic-peer-a/tool").size).toBe(0);
    expect(peer.lstat("/atomic-peer-b/tool").size).toBe(0);
  });

  it("rejects a required symlink removed by a peer", async () => {
    const regular = tarTreeFixture("first-use", "atomic-symlink-regular");
    const symlink = symlinkTreeFixture();
    const fs = createFs();
    fs.registerLazyTree(
      regular.content,
      regular.inventory,
      "/",
      {
        ...regular.activation,
        atomicGroup: {
          id: "atomic:symlink",
          member: "regular",
        },
      },
    );
    fs.registerLazyTree(
      symlink.content,
      symlink.inventory,
      "/",
      {
        mode: "first-use",
        capabilities: ["test:symlink"],
        roots: ["/metadata"],
        atomicGroup: {
          id: "atomic:symlink",
          member: "symlink",
        },
      },
    );
    await fs.sealLazyAtomicGroup("atomic:symlink", ["regular", "symlink"]);
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let started = 0;
    fs.setLazyFetcher(async (url) => {
      started += 1;
      await fetchGate;
      return new Response(
        url === regular.content.transports[0]
          ? regular.payload
          : symlink.payload,
      );
    });
    const activation = fs.preparePath("/atomic-symlink-regular/tool");
    await vi.waitFor(() => expect(started).toBe(2));
    peer.unlink("/metadata/runtime-link");
    releaseFetch();

    await expect(activation).rejects.toThrow(/changed before commit/);
    expect(fs.isPathDeferred("/atomic-symlink-regular/tool")).toBe(true);
    expect(peer.lstat("/atomic-symlink-regular/tool").size).toBe(0);
  });

  it("rejects a declared directory changed by a peer while fetching", async () => {
    const first = tarTreeFixture("first-use", "atomic-dir-a");
    const second = tarTreeFixture("first-use", "atomic-dir-b");
    const payloads = new Map([
      [first.content.transports[0], first.payload],
      [second.content.transports[0], second.payload],
    ]);
    const fs = createFs();
    await registerAtomicTrees(fs, "atomic:directory", [first, second]);
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let started = 0;
    fs.setLazyFetcher(async (url) => {
      started += 1;
      await fetchGate;
      return new Response(payloads.get(url)!);
    });
    const activation = fs.preparePath("/atomic-dir-a/tool");
    await vi.waitFor(() => expect(started).toBe(2));
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    peer.chmod("/atomic-dir-b", 0o700);
    releaseFetch();

    await expect(activation).rejects.toThrow(/changed before commit/);
    expect(peer.lstat("/atomic-dir-a/tool").size).toBe(0);
    expect(peer.lstat("/atomic-dir-b/tool").size).toBe(0);
    expect(fs.isPathDeferred("/atomic-dir-a/tool")).toBe(true);
    expect(fs.isPathDeferred("/atomic-dir-b/tool")).toBe(true);
  });

  it("drains a failed cohort preflight before allowing its retry", async () => {
    const failed = tarTreeFixture("first-use", "atomic-drain-failed");
    const slow = tarTreeFixture("first-use", "atomic-drain-slow");
    const fs = createFs();
    await registerAtomicTrees(fs, "atomic:drain", [failed, slow]);
    let repaired = false;
    let releaseSlow!: () => void;
    let activeSlow = 0;
    let maxActiveSlow = 0;
    let slowFetches = 0;
    let slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    fs.setLazyFetcher(async (url) => {
      if (url === failed.content.transports[0]) {
        return new Response(repaired ? failed.payload : new Uint8Array([0]));
      }
      slowFetches += 1;
      activeSlow += 1;
      maxActiveSlow = Math.max(maxActiveSlow, activeSlow);
      await slowGate;
      activeSlow -= 1;
      return new Response(slow.payload);
    });

    let rejected = false;
    const first = fs.preparePath("/atomic-drain-failed/tool").catch((error) => {
      rejected = true;
      throw error;
    });
    await vi.waitFor(() => expect(slowFetches).toBe(1));
    await Promise.resolve();
    expect(rejected).toBe(false);
    releaseSlow();
    await expect(first).rejects.toThrow(/All 1 lazy tree transports failed/);
    expect(activeSlow).toBe(0);

    repaired = true;
    slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const retry = fs.preparePath("/atomic-drain-slow/tool");
    await vi.waitFor(() => expect(slowFetches).toBe(2));
    expect(activeSlow).toBe(1);
    releaseSlow();
    await expect(retry).resolves.toBe(true);
    expect(maxActiveSlow).toBe(1);
  });

  it("rolls every member back after a later atomic write reaches ENOSPC", async () => {
    const dataA = "a".repeat(16 * 1024);
    const dataB = "b".repeat(16 * 1024);
    const first = tarTreeFixture("first-use", "atomic-space-a", dataA);
    const second = tarTreeFixture("first-use", "atomic-space-b", dataB);
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(512 * 1024),
    );
    await registerAtomicTrees(fs, "atomic:space", [first, second]);
    const reserve = fs.open("/reserve", O_WRONLY_CREAT, 0o600);
    expect(fs.write(
      reserve,
      new Uint8Array(24 * 1024),
      null,
      24 * 1024,
    )).toBe(24 * 1024);
    fs.close(reserve);
    const filler = fs.open("/filler", O_WRONLY_CREAT, 0o600);
    const chunk = new Uint8Array(64 * 1024).fill(0xa5);
    while (fs.write(filler, chunk, null, chunk.byteLength) > 0) {
      // Consume every remaining block after retaining a known six-block reserve.
    }
    fs.close(filler);
    fs.unlink("/reserve");
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    const beforeA = peer.lstat("/atomic-space-a/tool");
    const beforeB = peer.lstat("/atomic-space-b/tool");
    const payloads = new Map([
      [first.content.transports[0], first.payload],
      [second.content.transports[0], second.payload],
    ]);
    fs.setLazyFetcher(async (url) => new Response(payloads.get(url)!));

    await expect(
      fs.preparePath("/atomic-space-a/tool"),
    ).rejects.toThrow(/No space left/);
    expect(peer.lstat("/atomic-space-a/tool")).toEqual(beforeA);
    expect(peer.lstat("/atomic-space-b/tool")).toEqual(beforeB);
    expect(fs.isPathDeferred("/atomic-space-a/tool")).toBe(true);
    expect(fs.isPathDeferred("/atomic-space-b/tool")).toBe(true);

    // SharedFS may retain benign allocator/SAB growth, but releasing ordinary
    // filler capacity must make the exact unchanged cohort retryable.
    fs.unlink("/filler");
    await expect(
      fs.preparePath("/atomic-space-b/tool"),
    ).resolves.toBe(true);
    expect(readText(fs, "/atomic-space-a/tool")).toBe(dataA);
    expect(readText(fs, "/atomic-space-b/tool")).toBe(dataB);
  });

  it("bounds a representative 21-tree cohort to four concurrent preflights", async () => {
    const fixtures = Array.from({ length: 21 }, (_, index) =>
      tarTreeFixture("first-use", `atomic-bounded-${index}`)
    );
    const payloads = new Map(
      fixtures.map((fixture) => [
        fixture.content.transports[0],
        fixture.payload,
      ]),
    );
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(16 * 1024 * 1024),
    );
    await registerAtomicTrees(fs, "atomic:bounded", fixtures);
    let active = 0;
    let maximumActive = 0;
    let fetches = 0;
    fs.setLazyFetcher(async (url) => {
      fetches += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Response(payloads.get(url)!);
    });

    await expect(
      fs.preparePath("/atomic-bounded-0/tool"),
    ).resolves.toBe(true);
    expect(fetches).toBe(21);
    expect(maximumActive).toBe(4);
    expect(active).toBe(0);
    expect(fixtures.every((fixture) =>
      !fs.isPathDeferred(fixture.activation.roots[0]!)
    )).toBe(true);
  });

  it("rejects boot-prefetch trees and partial direct writes in an atomic group", async () => {
    const fixture = tarTreeFixture("first-use", "atomic-invalid");
    const fs = createFs();
    expect(() =>
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        {
          ...fixture.activation,
          mode: "boot-prefetch",
          atomicGroup: {
            id: "pkg:invalid",
            member: "invalid",
          },
        },
      )
    ).toThrow(/requires a valid first-use identity/);

    const first = tarTreeFixture("first-use", "atomic-direct-a");
    const second = tarTreeFixture("first-use", "atomic-direct-b");
    const singleton = createFs();
    const singletonHandle = singleton.registerLazyTreeWithMaterializationHandle(
      { ...first.content, transports: [] },
      first.inventory,
      "/",
      {
        ...first.activation,
        atomicGroup: {
          id: "pkg:direct-singleton",
          member: "direct-a",
        },
      },
    );
    await expect(
      singleton.materializeRegisteredDeferredTree(
        singletonHandle,
        first.payload,
      ),
    ).rejects.toThrow(/materialize the complete group/);

    const direct = createFs();
    const firstHandle = direct.registerLazyTreeWithMaterializationHandle(
      { ...first.content, transports: [] },
      first.inventory,
      "/",
      {
        ...first.activation,
        atomicGroup: {
          id: "pkg:direct",
          member: "direct-a",
        },
      },
    );
    direct.registerLazyTreeWithMaterializationHandle(
      { ...second.content, transports: [] },
      second.inventory,
      "/",
      {
        ...second.activation,
        atomicGroup: {
          id: "pkg:direct",
          member: "direct-b",
        },
      },
    );
    await expect(
      direct.materializeRegisteredDeferredTree(firstHandle, first.payload),
    ).rejects.toThrow(/materialize the complete group/);
    expect(direct.isPathDeferred("/atomic-direct-a/tool")).toBe(true);
    expect(direct.isPathDeferred("/atomic-direct-b/tool")).toBe(true);
  });

  it("binds direct materialization authority to one registered tree and filesystem", async () => {
    const fixture = tarTreeFixture("first-use");
    const owner = createFs();
    const foreign = createFs();
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    owner.setLazyFetcher(fetcher);
    const directContent = { ...fixture.content, transports: [] };
    expect(() => foreign.registerLazyTree(
      directContent,
      fixture.inventory,
      "/",
      fixture.activation,
    )).toThrow(/Lazy tree transports/);
    const handle = owner.registerLazyTreeWithMaterializationHandle(
      directContent,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    await expect(owner.saveImage()).rejects.toThrow(
      /must be materialized before serialization/,
    );

    await expect(
      foreign.materializeRegisteredDeferredTree(handle, fixture.payload),
    ).rejects.toThrow(
      /not issued by this filesystem/,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const wrongBytes = new Uint8Array(fixture.payload);
    wrongBytes[0] ^= 0xff;
    await expect(
      owner.materializeRegisteredDeferredTree(handle, wrongBytes),
    ).rejects.toThrow(/SHA-256/);
    const direct = owner.materializeRegisteredDeferredTree(handle, fixture.payload);
    const concurrentGuest = owner.preparePath("/runtime/tool");
    await expect(Promise.all([direct, concurrentGuest])).resolves.toEqual([true, true]);
    await expect(
      owner.materializeRegisteredDeferredTree(handle, fixture.payload),
    ).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(owner.exportLazyArchiveEntries()).toEqual([]);
    expect(
      MemoryFileSystem.fromImage(await owner.saveImage()).exportLazyArchiveEntries(),
    ).toEqual([]);
    expect(readText(owner, "/runtime/tool")).toBe("payload");
  });

  it("reports every deferred backing through direct and symlink paths without fetching", async () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    const legacyBytes = encoder.encode("legacy!");
    source.registerLazyFile(
      "/legacy-tool",
      "https://example.invalid/legacy-tool",
      legacyBytes.byteLength,
      0o755,
    );
    source.symlink("/runtime/tool", "/tree-link");
    source.symlink("/legacy-tool", "/legacy-link");
    source.mkdir("/concrete", 0o755);

    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async (url: string) => new Response(
      url.endsWith("/legacy-tool") ? legacyBytes : fixture.payload,
    ));
    restored.setLazyFetcher(fetcher);
    for (const path of [
      "/runtime/tool",
      "/tree-link",
      "/legacy-tool",
      "/legacy-link",
    ]) {
      expect(restored.isPathDeferred(path), path).toBe(true);
    }
    expect(restored.isPathDeferred("/concrete")).toBe(false);
    expect(restored.isPathDeferred("/missing")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    await expect(restored.preparePath("/tree-link")).resolves.toBe(true);
    expect(restored.isPathDeferred("/runtime/tool")).toBe(false);
    expect(restored.isPathDeferred("/tree-link")).toBe(false);
    await expect(restored.preparePath("/legacy-link")).resolves.toBe(true);
    expect(restored.isPathDeferred("/legacy-tool")).toBe(false);
    expect(restored.isPathDeferred("/legacy-link")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("tries byte-identical tree transports in declared order", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const primary = "https://primary.example.invalid/runtime.tar.gz";
    const mirror = "https://mirror.example.invalid/runtime.tar.gz";
    const fetcher = vi.fn(async (url: string) =>
      url === primary
        ? new Response(null, { status: 404 })
        : new Response(fixture.payload)
    );
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree({
      ...fixture.content,
      transports: [primary, mirror],
    }, fixture.inventory, "/", fixture.activation);

    await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([primary, mirror]);
    expect(readText(fs, "/runtime/tool")).toBe("payload");
  });

  it.each([408, 429, 500, 502, 599])(
    "retries transient HTTP %s responses on the same transport",
    async (status) => {
      const fixture = tarTreeFixture("first-use");
      const fs = createFs();
      const url = fixture.content.transports[0]!;
      const fetcher = vi.fn(async () =>
        fetcher.mock.calls.length === 1
          ? new Response(null, {
            status,
            headers: { "retry-after": "0" },
          })
          : new Response(fixture.payload)
      );
      fs.setLazyFetcher(fetcher);
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );

      await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.map(([requested]) => requested)).toEqual([
        url,
        url,
      ]);
    },
  );

  it.each([400, 401, 403, 404, 409, 499])(
    "does not retry permanent HTTP %s responses",
    async (status) => {
      const fixture = tarTreeFixture("first-use");
      const fs = createFs();
      const fetcher = vi.fn(async () => new Response(null, { status }));
      fs.setLazyFetcher(fetcher);
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );

      await expect(fs.preparePath("/runtime/tool")).rejects.toThrow(
        `HTTP ${status}`,
      );
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("bounds one transient transport to three total attempts", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const fetcher = vi.fn(async () =>
      new Response(null, {
        status: 503,
        headers: { "retry-after": "0" },
      })
    );
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );

    await expect(fs.preparePath("/runtime/tool")).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("exhausts one transient transport before advancing to its mirror", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const primary = "https://primary.example.invalid/transient.tar.gz";
    const mirror = "https://mirror.example.invalid/transient.tar.gz";
    const fetcher = vi.fn(async (url: string) =>
      url === primary
        ? new Response(null, {
          status: 503,
          headers: { "retry-after": "0" },
        })
        : new Response(fixture.payload)
    );
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree({
      ...fixture.content,
      transports: [primary, mirror],
    }, fixture.inventory, "/", fixture.activation);

    await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      primary,
      primary,
      primary,
      mirror,
    ]);
  });

  it("uses bounded backoff and honors Retry-After without sleeping in tests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    try {
      const fixture = tarTreeFixture("first-use");
      const fs = createFs();
      const fetcher = vi.fn(async () =>
        fetcher.mock.calls.length === 1
          ? new Response(null, { status: 502 })
          : fetcher.mock.calls.length === 2
            ? new Response(null, {
              status: 429,
              headers: {
                "retry-after": new Date(Date.now() + 60_000).toUTCString(),
              },
            })
            : new Response(fixture.payload)
      );
      fs.setLazyFetcher(fetcher);
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );

      const materialized = fs.preparePath("/runtime/tool");
      await vi.advanceTimersByTimeAsync(249);
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(materialized).resolves.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries fetch and response-stream network interruptions", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 1) {
        throw new TypeError("fetch failed");
      }
      if (fetcher.mock.calls.length === 2) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }), {
          headers: { "content-length": String(fixture.payload.byteLength) },
        });
      }
      return new Response(fixture.payload);
    });
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );

    vi.useFakeTimers();
    try {
      const materialized = fs.preparePath("/runtime/tool");
      await vi.runAllTimersAsync();
      await expect(materialized).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("preserves an oversize violation when stream cancellation rejects", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const oversized = new Uint8Array(fixture.payload.byteLength + 1);
    oversized.set(fixture.payload);
    const cancel = vi.fn(async () => {
      throw new TypeError("stream cancellation failed");
    });
    const fetcher = vi.fn(async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
        },
        cancel,
      }))
    );
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );

    await expect(fs.preparePath("/runtime/tool")).rejects.toThrow(
      `exceeded expected byte count ${fixture.payload.byteLength}`,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("stops a multi-mirror tree on a standard Fetch abort", async () => {
    const fixture = tarTreeFixture("first-use");
    const aborted = createFs();
    const reason = new DOMException("caller stopped", "AbortError");
    const abortFetch = vi.fn(async () => {
      throw reason;
    });
    aborted.setLazyFetcher(abortFetch);
    aborted.registerLazyTree({
      ...fixture.content,
      transports: [
        "https://primary.example.invalid/abort.tar.gz",
        "https://mirror.example.invalid/abort.tar.gz",
      ],
    }, fixture.inventory, "/", fixture.activation);

    await expect(aborted.preparePath("/runtime/tool")).rejects.toBe(reason);
    expect(abortFetch).toHaveBeenCalledOnce();
  });

  it("invokes an existing one-argument fetcher with exactly one argument", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const argumentCounts: number[] = [];
    const fetcher = vi.fn(async function (url: string) {
      argumentCounts.push(arguments.length);
      expect(url).toBe(fixture.content.transports[0]);
      return new Response(fixture.payload);
    });
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );

    await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
    expect(argumentCounts).toEqual([1]);
  });

  it("rethrows a pre-aborted registered signal before starting any mirror", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const controller = new AbortController();
    const reason = new Error("cancel before fetch");
    controller.abort(reason);
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    fs.setLazyFetcher(fetcher, { signal: controller.signal });
    fs.registerLazyTree({
      ...fixture.content,
      transports: [
        "https://primary.example.invalid/pre-abort.tar.gz",
        "https://mirror.example.invalid/pre-abort.tar.gz",
      ],
    }, fixture.inventory, "/", fixture.activation);

    await expect(fs.preparePath("/runtime/tool")).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["Error", () => new Error("custom cancellation")],
    ["TypeError", () => new TypeError("custom cancellation")],
    ["string", () => "primitive cancellation"],
  ] as const)(
    "preserves a registered signal's custom %s reason across mirrors",
    async (_label, createReason) => {
      const fixture = tarTreeFixture("first-use");
      const fs = createFs();
      const controller = new AbortController();
      const reason = createReason();
      const fetcher = vi.fn(async (
        _url: string,
        init?: { signal?: AbortSignal },
      ) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort(reason);
        return new Response(fixture.payload);
      });
      fs.setLazyFetcher(fetcher, { signal: controller.signal });
      fs.registerLazyTree({
        ...fixture.content,
        transports: [
          "https://primary.example.invalid/custom-abort.tar.gz",
          "https://mirror.example.invalid/custom-abort.tar.gz",
        ],
      }, fixture.inventory, "/", fixture.activation);

      await expect(fs.preparePath("/runtime/tool")).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fs.isPathDeferred("/runtime/tool")).toBe(true);
    },
  );

  it("preserves AbortSignal.timeout provenance across mirrors", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const signal = AbortSignal.timeout(10);
    const fetcher = vi.fn((
      _url: string,
      init?: { signal?: AbortSignal },
    ) =>
      new Promise<Response>((_resolve, reject) => {
        const registered = init?.signal;
        if (registered === undefined) {
          reject(new Error("lazy fetch signal was not forwarded"));
          return;
        }
        const onAbort = (): void => reject(registered.reason);
        if (registered.aborted) onAbort();
        else registered.addEventListener("abort", onAbort, { once: true });
      })
    );
    fs.setLazyFetcher(fetcher, { signal });
    fs.registerLazyTree({
      ...fixture.content,
      transports: [
        "https://primary.example.invalid/timeout.tar.gz",
        "https://mirror.example.invalid/timeout.tar.gz",
      ],
    }, fixture.inventory, "/", fixture.activation);

    let caught: unknown;
    try {
      await fs.preparePath("/runtime/tool");
    } catch (error) {
      caught = error;
    }
    expect(signal.aborted).toBe(true);
    expect(caught).toBe(signal.reason);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("interrupts a transient retry wait with the exact registered reason", async () => {
    vi.useFakeTimers();
    try {
      const fixture = tarTreeFixture("first-use");
      const fs = createFs();
      const controller = new AbortController();
      const reason = new Error("stop retry wait");
      const fetcher = vi.fn(async () => new Response(null, { status: 502 }));
      fs.setLazyFetcher(fetcher, { signal: controller.signal });
      fs.registerLazyTree({
        ...fixture.content,
        transports: [
          "https://primary.example.invalid/wait.tar.gz",
          "https://mirror.example.invalid/wait.tar.gz",
        ],
      }, fixture.inventory, "/", fixture.activation);

      const materialized = fs.preparePath("/runtime/tool");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledOnce();
      controller.abort(reason);
      await expect(materialized).rejects.toBe(reason);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry integrity or decoder failures", async () => {
    const fixture = tarTreeFixture("first-use");

    const changed = fixture.payload.slice();
    changed[0] ^= 0xff;
    const integrity = createFs();
    const integrityFetch = vi.fn(async () => new Response(changed));
    integrity.setLazyFetcher(integrityFetch);
    integrity.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    await expect(integrity.preparePath("/runtime/tool")).rejects.toThrow(
      /SHA-256/,
    );
    expect(integrityFetch).toHaveBeenCalledOnce();

    const undecodable = encoder.encode("not a gzip archive");
    const decoder = createFs();
    const decoderFetch = vi.fn(async () => new Response(undecodable));
    decoder.setLazyFetcher(decoderFetch);
    decoder.registerLazyTree({
      ...fixture.content,
      sha256: createHash("sha256").update(undecodable).digest("hex"),
      bytes: undecodable.byteLength,
    }, fixture.inventory, "/", fixture.activation);
    await expect(decoder.preparePath("/runtime/tool")).rejects.toThrow();
    expect(decoderFetch).toHaveBeenCalledOnce();
  });

  it("accepts every exact public activation and transport boundary", () => {
    const fixture = tarTreeFixture("first-use");
    const capabilities = Array.from(
      { length: VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities },
      (_, index) => index === 0
        ? "a".repeat(VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes)
        : `test:capability-${index.toString().padStart(2, "0")}`,
    );
    const roots = [
      "/runtime",
      ...Array.from(
        { length: VFS_DEFERRED_TREE_LIMITS.maxActivationRoots - 1 },
        (_, index) => `/activation-root-${index.toString().padStart(2, "0")}`,
      ),
    ];
    const inventory = [
      ...fixture.inventory,
      ...roots.slice(1).map((root) => ({
        vfsPath: root,
        sourcePath: root.slice(1),
        type: "directory" as const,
        mode: 0o755,
        size: 0,
      })),
    ];
    const transports = Array.from(
      { length: VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree },
      (_, index) => `https://example.invalid/runtime-${index}.tar.gz`,
    );
    const fs = createFs();
    expect(() => fs.registerLazyTree({
      ...fixture.content,
      sourceEntryCount: inventory.length,
      transports,
    }, inventory, "/", {
      mode: "first-use",
      capabilities,
      roots,
    })).not.toThrow();
    expect(fs.exportLazyArchiveEntries()[0]?.content?.transports).toHaveLength(
      VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree,
    );
  });

  it("round-trips decoder, inventory, activation, and inode groups through an image", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    const serialized = restored.exportLazyArchiveEntries()[0];

    expect(serialized.content).toEqual(fixture.content);
    expect(serialized.activation).toEqual(fixture.activation);
    expect(serialized.inventory).toEqual(fixture.inventory);
    expect(restored.lstat("/runtime/tool-hardlink").ino)
      .toBe(restored.lstat("/runtime/tool").ino);

    restored.setLazyFetcher(async () => new Response(fixture.payload));
    await restored.preparePath("/runtime/tool-hardlink");
    expect(readText(restored, "/runtime/tool")).toBe("payload");
  });

  it("keeps first-use trees inert and makes boot-prefetch failures fatal", async () => {
    const firstUse = tarTreeFixture("first-use", "first-use");
    const boot = tarTreeFixture("boot-prefetch", "boot");
    const fs = createFs();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("boot")) throw new Error("transport offline");
      return new Response(firstUse.payload);
    });
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      firstUse.content,
      firstUse.inventory,
      "/",
      firstUse.activation,
    );
    fs.registerLazyTree(boot.content, boot.inventory, "/", boot.activation);

    expect(fs.stat("/first-use/tool").size).toBe(7);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fs.prepareBootDeferredTrees()).rejects.toThrow("transport offline");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fs.stat("/first-use/tool").size).toBe(7);
  });

  it("bounds concurrent boot-prefetch buffers", async () => {
    const fixtures = Array.from({ length: 5 }, (_, index) =>
      tarTreeFixture("boot-prefetch", `boot-${index}`)
    );
    const payloads = new Map(fixtures.map((fixture) => [
      fixture.content.transports[0],
      fixture.payload,
    ]));
    const fs = createFs();
    let active = 0;
    let maximumActive = 0;
    fs.setLazyFetcher(async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(payloads.get(url)!);
    });
    for (const fixture of fixtures) {
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );
    }

    await expect(fs.prepareBootDeferredTrees()).resolves.toBe(fixtures.length);
    expect(maximumActive).toBe(2);
  });

  it("preserves and verifies a symlink-only boot-prefetch tree", async () => {
    const fixture = symlinkTreeFixture();
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    expect(source.exportLazyArchiveEntries()[0]).toMatchObject({
      mountPrefix: "/",
      materialized: false,
      entries: [],
    });
    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    restored.setLazyFetcher(fetcher);

    expect(restored.readlink("/metadata/runtime-link")).toBe("/runtime/target");
    expect(fetcher).not.toHaveBeenCalled();
    expect(restored.exportLazyArchiveEntries()).toHaveLength(1);
    await expect(restored.prepareBootDeferredTrees()).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
  });

  it("preserves a pending metadata-only tree after its regular names are removed", async () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    source.unlink("/runtime/tool-hardlink");
    source.unlink("/runtime/tool");
    expect(source.exportLazyArchiveEntries()[0]).toMatchObject({
      materialized: false,
      entries: [],
    });

    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    restored.setLazyFetcher(fetcher);
    await expect(restored.preparePath("/runtime")).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects inventory/content disagreement before mutating any stub", () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const inventory = fixture.inventory.filter(
      (entry) => entry.vfsPath !== "/runtime/tool-hardlink",
    );

    expect(() =>
      fs.registerLazyTree(fixture.content, inventory, "/", fixture.activation)
    ).toThrow(/source entry count differs/);
    expect(() => fs.lstat("/runtime")).toThrow();
  });

  it("rejects impossible hardlink metadata before namespace registration", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const alias = inventory.find((entry) => entry.type === "hardlink")!;
    alias.mode = 0o644;
    const fs = createFs();

    expect(() =>
      fs.registerLazyTree(
        fixture.content,
        inventory,
        "/",
        fixture.activation,
      )
    ).toThrow(/hardlink .* invalid target/);
    expect(() => fs.lstat("/runtime")).toThrow();
  });

  it("binds source-copy modes unless the producer explicitly overrides them", async () => {
    const fixture = completeSourceTreeFixture();
    const mismatched = structuredClone(fixture.inventory);
    mismatched.find((entry) => entry.materialization === "archive-copy")!.mode = 0o644;
    const rejected = createFs();

    expect(() => rejected.registerLazyTree(
      fixture.content,
      mismatched,
      "/",
      fixture.activation,
    )).toThrow(/archive copy .* differs from its source/);
    expect(() => rejected.lstat("/runtime")).toThrow();

    const overridden = structuredClone(fixture.inventory);
    const copy = overridden.find((entry) => entry.materialization === "archive-copy")!;
    copy.materialization = "archive-copy-mode";
    copy.mode = 0o644;
    const accepted = createFs();
    accepted.registerLazyTree(
      fixture.content,
      overridden,
      "/",
      fixture.activation,
    );
    expect(accepted.exportLazyArchiveEntries()[0]?.kind)
      .toBe("kandelo-deferred-tree-v2");
    const restored = MemoryFileSystem.fromImage(await accepted.saveImage());
    expect(restored.exportLazyArchiveEntries()[0]?.kind)
      .toBe("kandelo-deferred-tree-v2");
    const rebased = restored.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(rebased.exportLazyArchiveEntries()[0]?.kind)
      .toBe("kandelo-deferred-tree-v2");
    rebased.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(rebased.preparePath("/runtime/tool-copy")).resolves.toBe(true);
    expect(readText(rebased, "/runtime/tool-copy")).toBe("payload");
    expect(rebased.stat("/runtime/tool-copy").mode & 0o777).toBe(0o644);
  });

  it("keeps legacy v1 and complete-source v2 serialized shapes disjoint", () => {
    const legacyFixture = tarTreeFixture("first-use");
    const legacy = createFs();
    legacy.registerLazyTree(
      legacyFixture.content,
      legacyFixture.inventory,
      "/",
      legacyFixture.activation,
    );
    const legacyV1 = structuredClone(legacy.exportLazyArchiveEntries()[0]) as any;
    expect(legacyV1.kind).toBe("kandelo-deferred-tree-v1");
    legacyV1.kind = "kandelo-deferred-tree-v2";
    expect(() => MemoryFileSystem.fromExisting(legacy.sharedBuffer)
      .importLazyArchiveEntries([legacyV1]))
      .toThrow(/v2 requires complete source metadata/);

    const directFixture = completeSourceTreeFixture();
    const direct = createFs();
    direct.registerLazyTree(
      directFixture.content,
      directFixture.inventory,
      "/",
      directFixture.activation,
    );
    const directV2 = structuredClone(direct.exportLazyArchiveEntries()[0]) as any;
    expect(directV2.kind).toBe("kandelo-deferred-tree-v2");
    directV2.kind = "kandelo-deferred-tree-v1";
    expect(() => MemoryFileSystem.fromExisting(direct.sharedBuffer)
      .importLazyArchiveEntries([directV2]))
      .toThrow(/v1 cannot contain complete source metadata/);

    const incompleteV2 = structuredClone(direct.exportLazyArchiveEntries()[0]) as any;
    delete incompleteV2.content.source;
    for (const entry of incompleteV2.inventory) delete entry.materialization;
    incompleteV2.inventory = incompleteV2.inventory.filter(
      (entry: any) => entry.vfsPath !== "/runtime/tool-copy",
    );
    incompleteV2.entries = incompleteV2.entries.filter(
      (entry: any) => entry.vfsPath !== "/runtime/tool-copy",
    );
    expect(() => MemoryFileSystem.fromExisting(direct.sharedBuffer)
      .importLazyArchiveEntries([incompleteV2]))
      .toThrow(/v2 requires complete source metadata/);
  });

  it("preserves ZIP inventories whose hardlinks reuse the canonical member", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const file = inventory.find((entry) => entry.type === "file")!;
    const hardlink = inventory.find((entry) => entry.type === "hardlink")!;
    hardlink.sourcePath = file.sourcePath;
    const fs = createFs();

    fs.registerLazyTree({
      ...fixture.content,
      decoder: "zip-v1",
      mediaType: "application/zip",
      expandedBytes: 7,
      sourceEntryCount: 2,
      transports: ["https://example.invalid/runtime.zip"],
    }, inventory, "/", fixture.activation);

    expect(fs.lstat("/runtime/tool-hardlink").ino)
      .toBe(fs.lstat("/runtime/tool").ino);
  });

  it("bounds ZIP expansion by the declared inventory before mutating a stub", async () => {
    const uncompressed = new TextEncoder().encode("payload".repeat(4_096));
    const input: Zippable = {
      "runtime/tool": [uncompressed, {
        level: 9,
        os: 3,
        attrs: (((0o100000 | 0o755) << 16) >>> 0),
      }],
    };
    const payload = zipSync(input, { level: 9 });
    const centralOffset = findZipCentralDirectory(payload);
    new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      .setUint32(centralOffset + 24, 1, true);
    const fs = createFs();
    fs.registerLazyTree({
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: 1,
      sourceEntryCount: 1,
      transports: ["https://example.invalid/runtime.zip"],
    }, [{
      vfsPath: "/runtime/tool",
      sourcePath: "runtime/tool",
      type: "file",
      mode: 0o755,
      size: 1,
      inodeGroup: "runtime:tool",
    }], "/", {
      mode: "first-use",
      capabilities: ["test:zip-bound"],
      roots: ["/runtime/tool"],
    });
    fs.setLazyFetcher(async () => new Response(payload));

    await expect(fs.preparePath("/runtime/tool")).rejects.toThrow(
      /expands beyond 1 bytes/,
    );
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(peer.stat("/runtime/tool").size).toBe(0);
  });

  it("closes and bounds every live generic-tree schema component", () => {
    const fixture = tarTreeFixture("first-use");
    const cases: Array<{ mutate: (value: Record<string, any>) => void; error: RegExp }> = [
      {
        mutate: (value) => value.content.unexpected = true,
        error: /content has unexpected or missing fields/,
      },
      {
        mutate: (value) => value.activation.unexpected = true,
        error: /activation has unexpected or missing fields/,
      },
      {
        mutate: (value) => value.inventory[0].unexpected = true,
        error: /entry 0 has unexpected or missing fields/,
      },
      {
        mutate: (value) => value.activation.roots = ["/runtime/../escape"],
        error: /unsafe path segment/,
      },
      {
        mutate: (value) => value.activation.roots = ["/outside"],
        error: /is not owned by its inventory/,
      },
      {
        mutate: (value) => value.mountPrefix = "/runtime/../escape",
        error: /mount prefix is not canonical/,
      },
      {
        mutate: (value) => value.inventory[0].sourcePath = "x".repeat(4097),
        error: /canonical relative path/,
      },
      {
        mutate: (value) => value.content.transports = ["x".repeat(8193)],
        error: /exceeds 8192 bytes/,
      },
      {
        mutate: (value) => value.activation.capabilities = new Array(33).fill("test:x"),
        error: /must contain 1 to 32 items/,
      },
    ];

    for (const testCase of cases) {
      const value: Record<string, any> = {
        content: structuredClone(fixture.content),
        inventory: structuredClone(fixture.inventory),
        activation: structuredClone(fixture.activation),
        mountPrefix: "/",
      };
      testCase.mutate(value);
      const fs = createFs();
      expect(() =>
        fs.registerLazyTree(
          value.content,
          value.inventory,
          value.mountPrefix,
          value.activation,
        )
      ).toThrow(testCase.error);
      expect(() => fs.lstat("/runtime")).toThrow();
    }
  });

  it("rejects missing, cyclic, and cross-inode hardlinks before registration", () => {
    const fixture = tarTreeFixture("first-use");
    const missing = structuredClone(fixture.inventory);
    missing.find((entry) => entry.type === "hardlink")!.target = "/runtime/missing";
    expect(() =>
      createFs().registerLazyTree(
        fixture.content,
        missing,
        "/",
        fixture.activation,
      )
    ).toThrow(/target .* is missing/);

    const cyclic = structuredClone(fixture.inventory);
    const alias = cyclic.find((entry) => entry.type === "hardlink")!;
    alias.target = alias.vfsPath;
    expect(() =>
      createFs().registerLazyTree(
        fixture.content,
        cyclic,
        "/",
        fixture.activation,
      )
    ).toThrow(/cycle reaches/);

    const crossInode = structuredClone(fixture.inventory);
    crossInode.push({
      vfsPath: "/runtime/other",
      sourcePath: "runtime/other",
      type: "file",
      mode: 0o755,
      size: 7,
      inodeGroup: "runtime:other",
    });
    const crossAlias = crossInode.find((entry) => entry.type === "hardlink")!;
    crossAlias.target = "/runtime/other";
    const crossContent = {
      ...fixture.content,
      sourceEntryCount: fixture.content.sourceEntryCount + 1,
      expandedBytes: fixture.content.expandedBytes + 7,
    };
    expect(() =>
      createFs().registerLazyTree(
        crossContent,
        crossInode,
        "/",
        fixture.activation,
      )
    ).toThrow(/invalid target/);
  });

  it("validates imported generic metadata before installing any group", () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const serialized = source.exportLazyArchiveEntries();
    const cases: Array<{ mutate: (value: any) => unknown; error: RegExp }> = [
      {
        mutate: (value) => {
          delete value.kind;
          return value;
        },
        error: /missing its kind discriminator/,
      },
      {
        mutate: (value) => ({ ...value, unexpected: true }),
        error: /Serialized lazy tree has unexpected or missing fields/,
      },
      {
        mutate: (value) => {
          value.content.unexpected = true;
          return value;
        },
        error: /content has unexpected or missing fields/,
      },
      {
        mutate: (value) => {
          value.inventory[0].unexpected = true;
          return value;
        },
        error: /entry 0 has unexpected or missing fields/,
      },
      {
        mutate: (value) => {
          value.entries[0].size += 1;
          return value;
        },
        error: /disagrees with its inventory/,
      },
      {
        mutate: (value) => {
          value.entries = new Array(100_001).fill(value.entries[0]);
          return value;
        },
        error: /must contain 0 to 100000 items/,
      },
    ];

    for (const testCase of cases) {
      const candidate = testCase.mutate(structuredClone(serialized[0]));
      const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
      expect(() => peer.importLazyArchiveEntries([candidate] as any))
        .toThrow(testCase.error);
      expect(peer.exportLazyArchiveEntries()).toEqual([]);
    }
    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() =>
      peer.importLazyArchiveEntries(
        new Array(513).fill(serialized[0]) as any,
      )
    ).toThrow(/must contain 0 to 512 items/);
  });

  it("does not let ZIP deferred-tree metadata downgrade to the legacy schema", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const file = inventory.find((entry) => entry.type === "file")!;
    const hardlink = inventory.find((entry) => entry.type === "hardlink")!;
    hardlink.sourcePath = file.sourcePath;
    const source = createFs();
    source.registerLazyTree({
      ...fixture.content,
      decoder: "zip-v1",
      mediaType: "application/zip",
      expandedBytes: 7,
      sourceEntryCount: 2,
      transports: ["https://example.invalid/runtime.zip"],
    }, inventory, "/", fixture.activation);
    const downgraded = structuredClone(source.exportLazyArchiveEntries()[0]) as any;
    delete downgraded.kind;
    delete downgraded.content;
    delete downgraded.inventory;
    delete downgraded.activation;

    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => peer.importLazyArchiveEntries([downgraded]))
      .toThrow(/missing its kind discriminator/);
    expect(peer.exportLazyArchiveEntries()).toEqual([]);
  });

  it("commits no groups when a later imported inode identity is invalid", () => {
    const source = createFs();
    const first = tarTreeFixture("first-use", "first");
    const second = tarTreeFixture("first-use", "second");
    source.registerLazyTree(first.content, first.inventory, "/", first.activation);
    source.registerLazyTree(second.content, second.inventory, "/", second.activation);
    const serialized = structuredClone(source.exportLazyArchiveEntries());
    serialized[1].entries[0].ino += 1_000;

    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => peer.importLazyArchiveEntries(serialized))
      .toThrow(/stub .* has a different inode/);
    expect(peer.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects aggregate serialized-tree resource claims before installing groups", () => {
    const source = createFs();
    const first = tarTreeFixture("first-use", "aggregate-first");
    const second = tarTreeFixture("first-use", "aggregate-second");
    const third = tarTreeFixture("first-use", "aggregate-third");
    source.registerLazyTree(first.content, first.inventory, "/", first.activation);
    source.registerLazyTree(second.content, second.inventory, "/", second.activation);
    source.registerLazyTree(third.content, third.inventory, "/", third.activation);
    const serialized = structuredClone(source.exportLazyArchiveEntries()) as any[];

    const archiveShare = Math.floor(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes / serialized.length,
    ) + 1;
    for (const group of serialized) {
      group.content.bytes = archiveShare;
      group.integrity.bytes = group.content.bytes;
    }
    const archivePeer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => archivePeer.importLazyArchiveEntries(serialized as any))
      .toThrow(/collection exceeds the archive-byte cap/);
    expect(archivePeer.exportLazyArchiveEntries()).toEqual([]);

    const expanded = structuredClone(source.exportLazyArchiveEntries()) as any[];
    const expandedShare = Math.floor(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxExpandedBytes / expanded.length,
    ) + 1;
    for (const group of expanded) {
      group.content.expandedBytes = expandedShare;
    }
    const expandedPeer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => expandedPeer.importLazyArchiveEntries(expanded as any))
      .toThrow(/collection exceeds the expansion cap/);
    expect(expandedPeer.exportLazyArchiveEntries()).toEqual([]);

    const payloadSource = createFs();
    for (const root of ["payload-a", "payload-b", "payload-c"]) {
      const fixture = completeSourceTreeFixture(root);
      payloadSource.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );
    }
    const payload = structuredClone(payloadSource.exportLazyArchiveEntries()) as any[];
    for (const group of payload) {
      const largeSize = 90 * 1024 * 1024;
      for (const sourceEntry of group.content.source.entries) {
        if (sourceEntry.type === "file") sourceEntry.size = largeSize;
      }
      for (const entry of group.inventory) {
        if (entry.type === "file" || entry.type === "hardlink") entry.size = largeSize;
      }
      for (const entry of group.entries) entry.size = largeSize;
    }
    const payloadPeer = MemoryFileSystem.fromExisting(payloadSource.sharedBuffer);
    expect(() => payloadPeer.importLazyArchiveEntries(payload as any))
      .toThrow(/collection exceeds the payload-byte cap/);
    expect(payloadPeer.exportLazyArchiveEntries()).toEqual([]);

    const metadataGroup = (root: string) => ({
      kind: "kandelo-deferred-tree-v1",
      content: {
        ...first.content,
        expandedBytes: 50_001,
        sourceEntryCount: 50_001,
        transports: [`https://example.invalid/${root}.tar.gz`],
      },
      inventory: Array.from({ length: 50_001 }, (_, index) => ({
        vfsPath: `/${root}/link-${index.toString().padStart(5, "0")}`,
        sourcePath: `${root}/link-${index.toString().padStart(5, "0")}`,
        type: "symlink",
        mode: 0o777,
        size: 1,
        target: "x",
      })),
      activation: {
        mode: "first-use",
        capabilities: [`test:${root}`],
        roots: ["/"],
      },
      url: `https://example.invalid/${root}.tar.gz`,
      mountPrefix: "/",
      integrity: {
        sha256: first.content.sha256,
        bytes: first.content.bytes,
      },
      materialized: false,
      entries: [],
    });
    const entryPeer = createFs();
    expect(() => entryPeer.importLazyArchiveEntries([
      metadataGroup("aggregate-a"),
      metadataGroup("aggregate-b"),
    ] as any)).toThrow(/collection exceeds the entry-count cap/);
    expect(entryPeer.exportLazyArchiveEntries()).toEqual([]);
  });

  it("validates restore and rebases from private generic-tree authority", async () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const image = await source.saveImage();
    const serialized = source.exportLazyArchiveEntries();
    const unknown = structuredClone(serialized[0]) as any;
    unknown.activation.unexpected = true;
    expect(() =>
      MemoryFileSystem.fromImage(replaceLazyArchiveMetadata(image, [unknown]))
    ).toThrow(/activation has unexpected or missing fields/);

    const downgraded = structuredClone(serialized[0]) as any;
    delete downgraded.kind;
    delete downgraded.content;
    delete downgraded.inventory;
    delete downgraded.activation;
    expect(() =>
      MemoryFileSystem.fromImage(replaceLazyArchiveMetadata(image, [downgraded]))
    ).toThrow(/missing its kind discriminator/);

    const truncated = image.slice();
    const archiveOffset = lazyArchiveMetadataOffset(truncated);
    const truncatedView = new DataView(
      truncated.buffer,
      truncated.byteOffset,
      truncated.byteLength,
    );
    truncatedView.setUint32(
      archiveOffset,
      truncatedView.getUint32(archiveOffset, true) + 1,
      true,
    );
    expect(() => MemoryFileSystem.fromImage(truncated))
      .toThrow(/truncated \(lazy archive payload\)/);

    const oversized = image.slice();
    new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength)
      .setUint32(lazyArchiveMetadataOffset(oversized), 16 * 1024 * 1024 + 1, true);
    expect(() => MemoryFileSystem.fromImage(oversized))
      .toThrow(/lazy archive metadata exceeds/);

    const internal = source as unknown as {
      lazyArchiveGroups: Array<{ content: { expandedBytes: number } }>;
    };
    internal.lazyArchiveGroups[0].content.expandedBytes = 0;
    const rebased = source.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(rebased.exportLazyArchiveEntries()[0]!.content!.expandedBytes).toBe(
      fixture.content.expandedBytes,
    );
  });
});

function findZipCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) return offset;
  }
  throw new Error("central directory entry not found in test ZIP");
}

function lazyArchiveMetadataOffset(image: Uint8Array): number {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const sabLength = view.getUint32(12, true);
  const lazyOffset = 16 + sabLength;
  const lazyLength = view.getUint32(lazyOffset, true);
  return lazyOffset + 4 + lazyLength;
}

function replaceLazyArchiveMetadata(
  image: Uint8Array,
  metadata: unknown,
): Uint8Array {
  const archiveOffset = lazyArchiveMetadataOffset(image);
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const oldLength = view.getUint32(archiveOffset, true);
  const suffixOffset = archiveOffset + 4 + oldLength;
  const json = encoder.encode(JSON.stringify(metadata));
  const replaced = new Uint8Array(
    archiveOffset + 4 + json.byteLength + image.byteLength - suffixOffset,
  );
  replaced.set(image.subarray(0, archiveOffset), 0);
  new DataView(replaced.buffer).setUint32(archiveOffset, json.byteLength, true);
  replaced.set(json, archiveOffset + 4);
  replaced.set(image.subarray(suffixOffset), archiveOffset + 4 + json.byteLength);
  return replaced;
}

function zipTreeFixture(
  root: string,
  files: readonly (readonly [name: string, data: string])[],
) {
  const zippable: Zippable = {};
  const inventory: LazyTreeRegistrationEntry[] = [];
  let expandedBytes = 0;
  for (const [name, data] of files) {
    const sourcePath = `${root}/${name}`;
    const bytes = encoder.encode(data);
    expandedBytes += bytes.byteLength;
    zippable[sourcePath] = [bytes, {
      level: 0,
      os: 3,
      attrs: (((0o100000 | 0o755) << 16) >>> 0),
    }];
    inventory.push({
      vfsPath: `/${sourcePath}`,
      sourcePath,
      type: "file",
      mode: 0o755,
      size: bytes.byteLength,
      inodeGroup: `${root}:${name}`,
    });
  }
  const payload = zipSync(zippable, { level: 0 });
  return {
    payload,
    inventory,
    content: {
      decoder: "zip-v1" as const,
      mediaType: "application/zip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes,
      sourceEntryCount: files.length,
      transports: [`https://example.invalid/${root}.zip`],
    },
    activation: {
      mode: "first-use" as const,
      capabilities: [`test:${root}`],
      roots: [`/${root}`],
    } satisfies LazyTreeActivation,
  };
}

function tarTreeFixture(
  mode: LazyTreeActivation["mode"],
  root = "runtime",
  data = "payload",
) {
  const specs: TarSpec[] = [
    { path: root, type: "directory", mode: 0o755 },
    { path: `${root}/tool`, mode: 0o755, data },
    {
      path: `${root}/tool-hardlink`,
      type: "hardlink",
      mode: 0o755,
      target: `${root}/tool`,
    },
  ];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  const inventory: LazyTreeRegistrationEntry[] = [
    {
      vfsPath: `/${root}`,
      sourcePath: root,
      type: "directory",
      mode: 0o755,
      size: 0,
    },
    {
      vfsPath: `/${root}/tool`,
      sourcePath: `${root}/tool`,
      type: "file",
      mode: 0o755,
      size: encoder.encode(data).byteLength,
      inodeGroup: `${root}:tool`,
    },
    {
      vfsPath: `/${root}/tool-hardlink`,
      sourcePath: `${root}/tool-hardlink`,
      type: "hardlink",
      mode: 0o755,
      size: encoder.encode(data).byteLength,
      target: `/${root}/tool`,
      inodeGroup: `${root}:tool`,
    },
  ];
  return {
    payload,
    inventory,
    content: {
      decoder: "tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: specs.length,
      transports: [`https://example.invalid/${root}.tar.gz`],
    },
    activation: {
      mode,
      capabilities: [`test:${root}`],
      roots: [`/${root}`],
    } satisfies LazyTreeActivation,
  };
}

function exactGenericMaterializationPlan(): LazyTreeMaterializationPlan {
  return {
    schema: 1,
    kind: "archive-byte-transforms-v1",
    assertions: [{ sourcePath: "bin/tool", bytesHex: "2f6f6c642f" }],
    recipes: [{
      id: "prefix",
      replacements: [{
        matchHex: "2f6f6c642f",
        replacementHex: "2f6e65772f",
      }],
      rejectHex: ["2f666f7262696464656e2f"],
    }],
    transforms: [{
      sourcePath: "bin/tool",
      recipe: "prefix",
      input: {
        sha256: "0da8bba3f971e84a1cb42935a03959b06879abcffc01c472d41030227bb19cf7",
        bytes: 5,
      },
      output: {
        sha256: "92a2fb6a1bcf1f8af0366d946016ee2601311aae9106f6eccaf905b1bfc6ab04",
        bytes: 5,
      },
    }],
  };
}

function transformedGenericTarTreeFixture() {
  const specs: TarSpec[] = [{
    path: "bin",
    type: "directory",
    mode: 0o755,
  }, {
    path: "bin/tool",
    mode: 0o755,
    data: "/old/",
  }, {
    path: "bin/tool-alias",
    type: "hardlink",
    mode: 0o755,
    target: "bin/tool",
  }, {
    path: "current",
    type: "symlink",
    mode: 0o777,
    target: "bin/tool",
  }];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  const content = {
    decoder: "tar-gzip-v1" as const,
    mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
    sha256: createHash("sha256").update(payload).digest("hex"),
    bytes: payload.byteLength,
    expandedBytes: tar.byteLength,
    sourceEntryCount: 4,
    transports: ["https://example.invalid/generic-transformed.tar.gz"],
    source: {
      schema: 1 as const,
      kind: "archive-source-inventory-v1" as const,
      entries: [{
        sourcePath: "bin",
        type: "directory" as const,
        mode: 0o755,
        size: 0,
      }, {
        sourcePath: "bin/tool",
        type: "file" as const,
        mode: 0o755,
        size: 5,
      }, {
        sourcePath: "bin/tool-alias",
        type: "hardlink" as const,
        mode: 0o755,
        size: 0,
        target: "bin/tool",
      }, {
        sourcePath: "current",
        type: "symlink" as const,
        mode: 0o777,
        size: 0,
        target: "bin/tool",
      }],
    },
    materialization: exactGenericMaterializationPlan(),
  };
  const inventory: LazyTreeRegistrationEntry[] = [{
    vfsPath: "/srv",
    sourcePath: "projection-root",
    materialization: "descriptor",
    type: "directory",
    mode: 0o755,
    size: 0,
  }, {
    vfsPath: "/srv/bin",
    sourcePath: "bin",
    materialization: "archive",
    type: "directory",
    mode: 0o755,
    size: 0,
  }, {
    vfsPath: "/srv/bin/tool",
    sourcePath: "bin/tool",
    materialization: "archive",
    type: "file",
    mode: 0o755,
    size: 5,
    inodeGroup: "generic:tool",
  }, {
    vfsPath: "/srv/bin/tool-alias",
    sourcePath: "bin/tool-alias",
    materialization: "archive",
    type: "hardlink",
    mode: 0o755,
    size: 5,
    target: "/srv/bin/tool",
    inodeGroup: "generic:tool",
  }, {
    vfsPath: "/srv/current",
    sourcePath: "current",
    materialization: "archive",
    type: "symlink",
    mode: 0o777,
    size: 8,
    target: "bin/tool",
  }];
  return {
    payload,
    content,
    inventory,
    activation: {
      mode: "first-use" as const,
      capabilities: ["test:generic-transform"],
      roots: ["/srv"],
    } satisfies LazyTreeActivation,
  };
}

function completeSourceTreeFixture(root = "runtime") {
  const fixture = tarTreeFixture("first-use", root);
  const inventory: LazyTreeRegistrationEntry[] = fixture.inventory.map((entry) => ({
    ...entry,
    materialization: "archive",
  }));
  inventory.push({
    vfsPath: `/${root}/tool-copy`,
    sourcePath: `${root}/tool`,
    materialization: "archive-copy",
    type: "file",
    mode: 0o755,
    size: 7,
    inodeGroup: `${root}:tool-copy`,
  });
  return {
    ...fixture,
    content: {
      ...fixture.content,
      source: {
        schema: 1 as const,
        kind: "archive-source-inventory-v1" as const,
        entries: [
          {
            sourcePath: root,
            type: "directory" as const,
            mode: 0o755,
            size: 0,
          },
          {
            sourcePath: `${root}/tool`,
            type: "file" as const,
            mode: 0o755,
            size: 7,
          },
          {
            sourcePath: `${root}/tool-hardlink`,
            type: "hardlink" as const,
            mode: 0o755,
            size: 0,
            target: `${root}/tool`,
          },
        ],
      },
    },
    inventory,
  };
}

function symlinkTreeFixture() {
  const target = "/runtime/target";
  const specs: TarSpec[] = [{
    path: "metadata/runtime-link",
    type: "symlink",
    mode: 0o777,
    target,
  }];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  return {
    payload,
    inventory: [{
      vfsPath: "/metadata/runtime-link",
      sourcePath: "metadata/runtime-link",
      type: "symlink" as const,
      mode: 0o777,
      size: encoder.encode(target).byteLength,
      target,
    }],
    content: {
      decoder: "tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: specs.length,
      transports: ["https://example.invalid/metadata.tar.gz"],
    },
    activation: {
      mode: "boot-prefetch" as const,
      capabilities: ["test:metadata"],
      roots: ["/metadata"],
    },
  };
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
}

function expectImportedAtomicInspectionBlocked(fs: MemoryFileSystem): void {
  const failure = /not been cryptographically verified after import/;
  expect(() => fs.exportLazyArchiveEntries()).toThrow(failure);
  expect(() => fs.pendingDeferredTreeUsage()).toThrow(failure);
  expect(() => fs.rebaseToNewFileSystem(8 * 1024 * 1024)).toThrow(failure);
}

async function importedAtomicPair(id: string, root: string): Promise<{
  fs: MemoryFileSystem;
  payloads: Map<string, Uint8Array>;
  roots: { first: string; second: string };
  paths: { first: string; second: string };
}> {
  const first = tarTreeFixture("first-use", `${root}-first`);
  const second = tarTreeFixture("first-use", `${root}-second`);
  const source = createFs();
  await registerAtomicTrees(source, id, [first, second]);
  return {
    fs: MemoryFileSystem.fromImage(await source.saveImage()),
    payloads: new Map([
      [first.content.transports[0]!, first.payload],
      [second.content.transports[0]!, second.payload],
    ]),
    roots: {
      first: first.activation.roots[0]!,
      second: second.activation.roots[0]!,
    },
    paths: {
      first: `${first.activation.roots[0]!}/tool`,
      second: `${second.activation.roots[0]!}/tool`,
    },
  };
}

function importedAtomicGroups(fs: MemoryFileSystem): LazyTreeGroup[] {
  return (fs as unknown as { lazyArchiveGroups: LazyTreeGroup[] })
    .lazyArchiveGroups;
}

function gatedSha256Digests() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const gate = deferredGate();
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(
    async (algorithm, input) => {
      await gate.promise;
      return digest(algorithm, input);
    },
  );
  return {
    spy,
    release: gate.resolve,
  };
}

function deferredGate(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

async function registerAtomicTrees(
  fs: MemoryFileSystem,
  id: string,
  fixtures: readonly ReturnType<typeof tarTreeFixture>[],
): Promise<void> {
  const members = fixtures.map((fixture) => fixture.activation.capabilities[0]!);
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    fs.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      {
        ...fixture.activation,
        atomicGroup: { id, member: members[index] },
      },
    );
  }
  await fs.sealLazyAtomicGroup(id, members);
}

function readText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return decoder.decode(bytes);
}

function tarBytes(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 2 * BLOCK;
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "");
    const payload = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK);
    payload.set(data);
    const header = tarHeader(entry, data.byteLength);
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function tarHeader(entry: TarSpec, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory"
    ? "5".charCodeAt(0)
    : entry.type === "hardlink"
      ? "1".charCodeAt(0)
      : entry.type === "symlink"
        ? "2".charCodeAt(0)
        : "0".charCodeAt(0);
  if (entry.target) writeString(header, 157, 100, entry.target);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error("test TAR field is too long");
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 2, "0")}\0`,
  );
}
