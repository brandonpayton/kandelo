import { describe, expect, it } from "vitest";
import {
  ForkModuleStateRecordKind,
  type ForkModuleStateRecord,
} from "../src/fork-module-state";
import type {
  ForkReferenceRecipeEntry,
} from "../src/fork-reference-recipes";
import {
  advanceForkReferenceLogicalOffset,
  decodeSegmentedForkReferenceTransaction,
  encodeSegmentedForkReferenceRecords,
  findForkReferenceVectorOrdinal,
  forkReferenceVectorFrom,
  ForkReferenceDirectoryOverlay,
  PagedForkReferenceVector,
  scanSegmentedForkReferenceExternrefHandles,
} from "../src/fork-reference-segments";
import {
  FORK_REFERENCE_TRANSACTION_OWNER_ID,
} from "../src/fork-reference-wire";

function graph(): ForkReferenceRecipeEntry[] {
  return [
    { id: 0, node: { kind: "null" } },
    { id: 1, node: { kind: "externref", handle: 17 } },
    {
      id: 2,
      node: {
        kind: "struct",
        moduleActivation: 4,
        typeOrdinal: 9,
        layoutId: 12,
        scalars: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
        fields: [1, 2],
      },
    },
    {
      id: 3,
      node: {
        kind: "exnref",
        moduleActivation: 4,
        tagOrdinal: 3,
        layoutId: 8,
        scalars: Uint8Array.of(0xaa, 0xbb, 0xcc),
        payloads: [2, 1],
      },
    },
    {
      id: 4,
      node: {
        kind: "funcref",
        moduleActivation: 4,
        functionOrdinal: 21,
      },
    },
    { id: 5, node: { kind: "i31", value: -37 } },
    {
      id: 6,
      node: {
        kind: "static-root",
        moduleActivation: 4,
        staticRootOrdinal: 5,
      },
    },
  ];
}

function vectors(): [
  PagedForkReferenceVector,
  PagedForkReferenceVector,
  PagedForkReferenceVector,
] {
  return [
    PagedForkReferenceVector.empty,
    forkReferenceVectorFrom([1, 2, 0, 3], 4),
    forkReferenceVectorFrom([6, 4, 5], 3),
  ];
}

function records(segmentDataBytes = 7): ForkModuleStateRecord[] {
  return encodeSegmentedForkReferenceRecords(
    FORK_REFERENCE_TRANSACTION_OWNER_ID,
    graph(),
    vectors(),
    { segmentDataBytes },
  );
}

function cloneRecords(
  source: readonly ForkModuleStateRecord[],
): ForkModuleStateRecord[] {
  return source.map((record) => ({
    ...record,
    payload: record.payload.slice(),
  }));
}

function segmentRecords(
  source: readonly ForkModuleStateRecord[],
): ForkModuleStateRecord[] {
  return source.filter(
    ({ kind }) => kind === ForkModuleStateRecordKind.ReferenceRecipeSegment,
  );
}

function manifestRecord(
  source: readonly ForkModuleStateRecord[],
): ForkModuleStateRecord {
  return source.find(
    ({ kind }) => kind === ForkModuleStateRecordKind.ReferenceRecipe,
  )!;
}

function sectionSegment(
  source: readonly ForkModuleStateRecord[],
  section: number,
): ForkModuleStateRecord {
  return segmentRecords(source).find((record) =>
    new DataView(
      record.payload.buffer,
      record.payload.byteOffset,
      record.payload.byteLength,
    ).getUint16(8, true) === section
  )!;
}

describe("segmented KFRV v2", () => {
  it("decodes fields split across many records without concatenating them", () => {
    const encoded = records();
    expect(segmentRecords(encoded).length).toBeGreaterThan(40);

    const decoded = decodeSegmentedForkReferenceTransaction(
      encoded,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    );
    expect(decoded.graph.roots).toEqual([]);
    expect(decoded.graph.nodes.length).toBe(7);
    expect(decoded.graph.nodes.get(1)?.node).toEqual({
      kind: "externref",
      handle: 17,
    });
    expect(decoded.graph.nodes.get(2)?.node).toEqual({
      kind: "struct",
      moduleActivation: 4,
      typeOrdinal: 9,
      layoutId: 12,
      scalars: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9),
      fields: [1, 2],
    });
    expect(decoded.graph.nodes.get(3)?.node).toEqual({
      kind: "exnref",
      moduleActivation: 4,
      tagOrdinal: 3,
      layoutId: 8,
      scalars: Uint8Array.of(0xaa, 0xbb, 0xcc),
      payloads: [2, 1],
    });
    expect([...decoded.vectors.get(1)!]).toEqual([1, 2, 0, 3]);
    expect([...decoded.vectors.get(2)!]).toEqual([6, 4, 5]);
    expect(scanSegmentedForkReferenceExternrefHandles(
      encoded,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    )).toEqual(new Set([17]));
  });

  it("preserves deep cycles and paged vectors across hundreds of segments", () => {
    const nodeCount = 2_000;
    const nodes: ForkReferenceRecipeEntry[] = [
      { id: 0, node: { kind: "null" } },
    ];
    for (let id = 1; id < nodeCount; id++) {
      nodes.push({
        id,
        node: {
          kind: "struct",
          moduleActivation: 1,
          typeOrdinal: 0,
          fields: [id + 1 === nodeCount ? 1 : id + 1, 1],
        },
      });
    }
    const vectorValues = Array.from(
      { length: 10_000 },
      (_, index) => index % nodeCount,
    );
    const encoded = encodeSegmentedForkReferenceRecords(
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
      nodes,
      [
        PagedForkReferenceVector.empty,
        forkReferenceVectorFrom(vectorValues, vectorValues.length),
      ],
      { segmentDataBytes: 127 },
    );
    expect(segmentRecords(encoded).length).toBeGreaterThan(800);

    const decoded = decodeSegmentedForkReferenceTransaction(
      encoded,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    );
    expect(decoded.graph.nodes.length).toBe(nodeCount);
    expect(decoded.graph.nodes.get(nodeCount - 1)?.node).toMatchObject({
      kind: "struct",
      fields: [1, 1],
    });
    const vector = decoded.vectors.get(1)!;
    expect(vector.length).toBe(10_000);
    expect(vector.get(0)).toBe(0);
    expect(vector.get(4_096)).toBe(96);
    expect(vector.get(9_999)).toBe(1_999);
  });

  it("shares decoded vectors through an append-only replay overlay", () => {
    const decoded = decodeSegmentedForkReferenceTransaction(
      records(),
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    );
    const overlay = new ForkReferenceDirectoryOverlay(decoded.vectors);
    expect(overlay.get(1)).toBe(decoded.vectors.get(1));
    expect(findForkReferenceVectorOrdinal(
      [decoded.vectorIntern],
      overlay,
      forkReferenceVectorFrom([1, 2, 0, 3]),
    )).toBe(1);

    const appended = forkReferenceVectorFrom([5, 4], 2);
    const ordinal = overlay.length;
    overlay.push(appended);
    expect(overlay.get(ordinal)).toBe(appended);
    expect(decoded.vectors.length).toBe(3);
  });

  it.each([
    {
      name: "a missing segment",
      mutate(source: ForkModuleStateRecord[]) {
        source.splice(source.indexOf(segmentRecords(source)[2]!), 1);
      },
      message: "ordinal",
    },
    {
      name: "a duplicate or reordered ordinal",
      mutate(source: ForkModuleStateRecord[]) {
        const segments = segmentRecords(source);
        const firstIndex = source.indexOf(segments[0]!);
        const secondIndex = source.indexOf(segments[1]!);
        [source[firstIndex], source[secondIndex]] = [
          source[secondIndex]!,
          source[firstIndex]!,
        ];
      },
      message: "ordinal",
    },
    {
      name: "a gap",
      mutate(source: ForkModuleStateRecord[]) {
        const segment = segmentRecords(source)[1]!;
        const view = new DataView(segment.payload.buffer);
        view.setBigUint64(24, view.getBigUint64(24, true) + 1n, true);
      },
      message: "gap, overlap, or duplicate",
    },
    {
      name: "an overlap",
      mutate(source: ForkModuleStateRecord[]) {
        const segment = segmentRecords(source)[1]!;
        const view = new DataView(segment.payload.buffer);
        view.setBigUint64(24, view.getBigUint64(24, true) - 1n, true);
      },
      message: "gap, overlap, or duplicate",
    },
    {
      name: "trailing segment bytes",
      mutate(source: ForkModuleStateRecord[]) {
        const segment = segmentRecords(source)[0]!;
        const payload = new Uint8Array(segment.payload.byteLength + 1);
        payload.set(segment.payload);
        segment.payload = payload;
      },
      message: "invalid data length",
    },
    {
      name: "a segment after the manifest",
      mutate(source: ForkModuleStateRecord[]) {
        const manifest = manifestRecord(source);
        const segment = source.splice(
          source.indexOf(manifest) - 1,
          1,
        )[0]!;
        source.push(segment);
      },
      message: "follows its final manifest",
    },
  ])("rejects $name before materialization", ({ mutate, message }) => {
    const malformed = cloneRecords(records());
    mutate(malformed);
    expect(() => decodeSegmentedForkReferenceTransaction(
      malformed,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    )).toThrow(message);
  });

  it("rejects invalid semantic edges and noncanonical vector indexes", () => {
    const badEdge = cloneRecords(records(64));
    const edge = sectionSegment(badEdge, 2);
    new DataView(
      edge.payload.buffer,
      edge.payload.byteOffset,
      edge.payload.byteLength,
    ).setUint32(40, 0xffff_ffff, true);
    expect(() => decodeSegmentedForkReferenceTransaction(
      badEdge,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    )).toThrow("missing recipe");

    const badIndex = cloneRecords(records(64));
    const index = sectionSegment(badIndex, 4);
    new DataView(
      index.payload.buffer,
      index.payload.byteOffset,
      index.payload.byteLength,
    ).setBigUint64(40 + 16, 99n, true);
    expect(() => decodeSegmentedForkReferenceTransaction(
      badIndex,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    )).toThrow("expected");
  });

  it("rejects wrong ownership and a duplicate canonical vector", () => {
    const wrongOwner = cloneRecords(records());
    wrongOwner[0]!.ownerId++;
    expect(() => decodeSegmentedForkReferenceTransaction(
      wrongOwner,
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
    )).toThrow("invalid process ownership");

    expect(() => encodeSegmentedForkReferenceRecords(
      FORK_REFERENCE_TRANSACTION_OWNER_ID,
      graph(),
      [
        PagedForkReferenceVector.empty,
        forkReferenceVectorFrom([1, 2], 2),
        forkReferenceVectorFrom([1, 2], 2),
      ],
    )).toThrow("duplicates canonical vector");
  });

  it("uses u64 logical offsets without a 4-GiB allocation", () => {
    expect(advanceForkReferenceLogicalOffset(
      0xffff_fff0n,
      0x40,
    )).toBe(0x1_0000_0030n);
    expect(() => advanceForkReferenceLogicalOffset(
      0xffff_ffff_ffff_fff0n,
      0x40,
    )).toThrow("exceeds u64");
  });
});
