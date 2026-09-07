import {
  ForkModuleStateRecordKind,
  type ForkModuleStateArena,
  type ForkModuleStateRecord,
  type ForkModuleStateRecordView,
} from "./fork-module-state";
import type {
  ForkReferenceRecipeEntry,
  ForkReferenceRecipeNode,
} from "./fork-reference-recipes";
import {
  WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS,
} from "./generated/abi";
import {
  addU64,
  assertOwner,
  assertU32,
  decodeHandle,
  decodeNodeHeader,
  FORK_REFERENCE_MANIFEST_FLAG_SEALED,
  FORK_REFERENCE_MANIFEST_SIZE,
  FORK_REFERENCE_NODE_RECORD_SIZE,
  FORK_REFERENCE_SEGMENT_HEADER_SIZE,
  FORK_REFERENCE_TRANSACTION_VERSION,
  FORK_REFERENCE_VECTOR_INDEX_SIZE,
  KFRS_MAGIC,
  KFRV_MAGIC,
  MAX_U32,
  MAX_U32_DIRECTORY_LENGTH,
  multiplyU64,
  PagedForkReferenceDirectory,
  parseSegmentedForkReferenceTransaction,
  ReferenceSection,
  requiredDirectoryEntry,
  requiredSection,
  sectionTotalsArray,
  validateReferenceSemantics,
  VECTOR_PAGE_ENTRIES,
  WireNodeKind,
  type DecodedNodeHeader,
  type ForkReferenceDirectory,
  type ForkReferenceSegmentEncodingOptions,
  type ForkReferenceSequence,
  type ForkReferenceVectorInternIndex,
  type MutableForkReferenceVectorInternIndex,
  type ParsedSegmentedForkReferenceTransaction,
  type SectionTotals,
  type ValidatedReferenceSemantics,
} from "./fork-reference-wire";

// The read-only KFRV v2 wire parser, semantic validator, externref-handle
// scan, and their shared primitives now live in the staying
// `fork-reference-wire.ts` glue so the Kernel-Worker process owner can consume
// the scan without importing this deletable engine file. This module keeps the
// encode side and the graph/vector materializers, re-exporting the moved public
// symbols so existing importers see an unchanged surface.
export {
  FORK_REFERENCE_MANIFEST_SIZE,
  FORK_REFERENCE_NODE_RECORD_SIZE,
  FORK_REFERENCE_SEGMENT_HEADER_SIZE,
  FORK_REFERENCE_TRANSACTION_VERSION,
  FORK_REFERENCE_VECTOR_INDEX_SIZE,
  PagedForkReferenceDirectory,
  scanSegmentedForkReferenceExternrefHandles,
} from "./fork-reference-wire";
export type {
  ForkReferenceDirectory,
  ForkReferenceSegmentEncodingOptions,
  ForkReferenceVectorInternIndex,
  MutableForkReferenceVectorInternIndex,
} from "./fork-reference-wire";

export const DEFAULT_FORK_REFERENCE_SEGMENT_DATA_BYTES = 1024 * 1024;

/**
 * Read-only paged storage for one activation recipe-ID vector.
 *
 * A vector may grow to the generated Wasm u32 index boundary without asking
 * JavaScript for one equally large dense Array. Pages are private and become
 * immutable when the builder finishes.
 */
export interface ForkReferenceVector extends Iterable<number> {
  readonly length: number;
  get(index: number): number | undefined;
  forEach(callback: (value: number, index: number) => void): void;
}

/**
 * Mutable tail layered over one immutable decoded directory.
 *
 * Early replay and ordinary replay both need to intern short-lived codec
 * vectors after decoding KFRV. Keeping the decoded directory as the base avoids
 * copying every vector reference into a second page tree merely to make the
 * tail appendable.
 */
export class ForkReferenceDirectoryOverlay<T>
  implements ForkReferenceDirectory<T>
{
  private base: ForkReferenceDirectory<T> =
    new PagedForkReferenceDirectory<T>();
  private readonly extension = new PagedForkReferenceDirectory<T>();

  constructor(base?: ForkReferenceDirectory<T>) {
    if (base) this.base = base;
  }

  get length(): number {
    return this.base.length + this.extension.length;
  }

  get(index: number): T | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      return undefined;
    }
    return index < this.base.length
      ? this.base.get(index)
      : this.extension.get(index - this.base.length);
  }

  has(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      return false;
    }
    return index < this.base.length
      ? this.base.has(index)
      : this.extension.has(index - this.base.length);
  }

  push(value: T): number {
    if (this.length >= MAX_U32_DIRECTORY_LENGTH) {
      throw new RangeError("fork reference u32 directory is exhausted");
    }
    this.extension.push(value);
    return this.length;
  }

  reset(base?: ForkReferenceDirectory<T>): void {
    this.extension.clear();
    this.base = base ?? new PagedForkReferenceDirectory<T>();
  }

  clear(): void {
    this.reset();
  }

  forEach(callback: (value: T, index: number) => void): void {
    this.base.forEach(callback);
    const baseLength = this.base.length;
    this.extension.forEach((value, index) => {
      callback(value, baseLength + index);
    });
  }

  some(predicate: (value: T, index: number) => boolean): boolean {
    if (this.base.some(predicate)) return true;
    const baseLength = this.base.length;
    return this.extension.some((value, index) =>
      predicate(value, baseLength + index)
    );
  }

  *[Symbol.iterator](): Iterator<T> {
    yield* this.base;
    yield* this.extension;
  }
}

export class PagedForkReferenceVector implements ForkReferenceVector {
  static readonly empty = new PagedForkReferenceVector(new Map(), 0);

  constructor(
    private readonly pages: ReadonlyMap<number, Uint32Array>,
    readonly length: number,
  ) {
    if (!Number.isInteger(length) || length < 0 || length > MAX_U32) {
      throw new RangeError(`fork reference vector length ${length} is not a u32`);
    }
  }

  get(index: number): number | undefined {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      return undefined;
    }
    return this.pages.get(Math.floor(index / VECTOR_PAGE_ENTRIES))![
      index % VECTOR_PAGE_ENTRIES
    ];
  }

  forEach(callback: (value: number, index: number) => void): void {
    let index = 0;
    const pageCount = Math.ceil(this.length / VECTOR_PAGE_ENTRIES);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = this.pages.get(pageIndex)!;
      const remaining = this.length - index;
      const count = Math.min(page.length, remaining);
      for (let local = 0; local < count; local++, index++) {
        callback(page[local]!, index);
      }
    }
  }

  *[Symbol.iterator](): Iterator<number> {
    let emitted = 0;
    const pageCount = Math.ceil(this.length / VECTOR_PAGE_ENTRIES);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = this.pages.get(pageIndex)!;
      const count = Math.min(page.length, this.length - emitted);
      for (let index = 0; index < count; index++, emitted++) {
        yield page[index]!;
      }
    }
  }
}

export class ForkReferenceVectorBuilder {
  private readonly pages = new Map<number, Uint32Array>();
  private count = 0;

  constructor(readonly expectedLength: number) {
    if (
      !Number.isInteger(expectedLength)
      || expectedLength <= 0
      || expectedLength > MAX_U32
    ) {
      throw new RangeError(
        `fork reference vector length ${expectedLength} is not a nonzero u32`,
      );
    }
  }

  get length(): number {
    return this.count;
  }

  append(recipeId: number): void {
    assertRecipeId(recipeId, "fork reference vector recipe");
    if (this.count >= this.expectedLength) {
      throw new Error("fork reference vector exceeds its declared length");
    }
    const pageIndex = Math.floor(this.count / VECTOR_PAGE_ENTRIES);
    let page = this.pages.get(pageIndex);
    if (!page) {
      page = new Uint32Array(
        Math.min(VECTOR_PAGE_ENTRIES, this.expectedLength - this.count),
      );
      this.pages.set(pageIndex, page);
    }
    page[this.count % VECTOR_PAGE_ENTRIES] = recipeId;
    this.count++;
  }

  finish(): PagedForkReferenceVector {
    if (this.count !== this.expectedLength) {
      throw new Error(
        `fork reference vector has ${this.count} entries; `
        + `expected ${this.expectedLength}`,
      );
    }
    return new PagedForkReferenceVector(new Map(this.pages), this.count);
  }
}

export function forkReferenceVectorFrom(
  values: Iterable<number>,
  expectedLength?: number,
): PagedForkReferenceVector {
  if (expectedLength === 0) return PagedForkReferenceVector.empty;
  if (expectedLength !== undefined) {
    const builder = new ForkReferenceVectorBuilder(expectedLength);
    for (const value of values) builder.append(value);
    return builder.finish();
  }
  const pages = new Map<number, Uint32Array>();
  let count = 0;
  for (const value of values) {
    assertRecipeId(value, "fork reference vector recipe");
    if (count === MAX_U32) {
      throw new RangeError("fork reference vector length exceeds u32");
    }
    const pageIndex = Math.floor(count / VECTOR_PAGE_ENTRIES);
    let page = pages.get(pageIndex);
    if (!page) {
      page = new Uint32Array(VECTOR_PAGE_ENTRIES);
      pages.set(pageIndex, page);
    }
    page[count % VECTOR_PAGE_ENTRIES] = value;
    count++;
  }
  return count === 0
    ? PagedForkReferenceVector.empty
    : new PagedForkReferenceVector(pages, count);
}

export function forkReferenceVectorsEqual(
  left: ForkReferenceVector,
  right: ForkReferenceVector,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left.get(index) !== right.get(index)) return false;
  }
  return true;
}

export function forkReferenceVectorInternKey(
  values: ForkReferenceVector,
): string {
  let first = (0x811c_9dc5 ^ values.length) >>> 0;
  let second = (0x9e37_79b9 ^ values.length) >>> 0;
  values.forEach((value) => {
    first = Math.imul(first ^ value, 0x0100_0193) >>> 0;
    const rotated = ((value << 16) | (value >>> 16)) >>> 0;
    second = Math.imul(second ^ rotated, 0x85eb_ca6b) >>> 0;
    second = (second ^ (first >>> 13)) >>> 0;
  });
  return `${values.length}:${first}:${second}`;
}

export function indexForkReferenceVector(
  index: MutableForkReferenceVectorInternIndex,
  values: ForkReferenceVector,
  ordinal: number,
): void {
  assertU32(ordinal, "fork reference vector ordinal");
  const key = forkReferenceVectorInternKey(values);
  let candidates = index.get(key);
  if (!candidates) {
    candidates = new PagedForkReferenceDirectory<number>();
    index.set(key, candidates);
  }
  candidates.push(ordinal);
}

export function findForkReferenceVectorOrdinal(
  indexes: Iterable<ForkReferenceVectorInternIndex>,
  directory: ForkReferenceDirectory<ForkReferenceVector>,
  values: ForkReferenceVector,
): number | undefined {
  const key = forkReferenceVectorInternKey(values);
  for (const index of indexes) {
    const candidates = index.get(key);
    if (!candidates) continue;
    for (const ordinal of candidates) {
      const candidate = directory.get(ordinal);
      if (candidate && forkReferenceVectorsEqual(candidate, values)) {
        return ordinal;
      }
    }
  }
  return undefined;
}

export interface DecodedSegmentedForkReferenceTransaction {
  /**
   * One object is shared by pre-instantiation and ordinary child replay.
   * Object identity is the adoption proof; no complete wire copy is retained.
   */
  readonly identity: object;
  readonly graph: {
    readonly roots: readonly number[];
    readonly nodes: ForkReferenceDirectory<ForkReferenceRecipeEntry>;
  };
  /** Index zero is the canonical empty-vector sentinel. */
  readonly vectors: ForkReferenceDirectory<ForkReferenceVector>;
  /** Canonical hash candidates shared by early and ordinary replay. */
  readonly vectorIntern: ForkReferenceVectorInternIndex;
}

interface SegmentState {
  ordinal: bigint;
}

class SegmentWriter {
  private readonly buffer: Uint8Array;
  private used = 0;
  private logicalOffset = 0n;

  constructor(
    private readonly arena: ForkModuleStateArena,
    private readonly ownerId: number,
    private readonly section: ReferenceSection,
    private readonly state: SegmentState,
    segmentDataBytes: number,
  ) {
    this.buffer = new Uint8Array(segmentDataBytes);
  }

  write(bytes: Uint8Array): void {
    let source = 0;
    while (source < bytes.byteLength) {
      const count = Math.min(
        bytes.byteLength - source,
        this.buffer.byteLength - this.used,
      );
      this.buffer.set(bytes.subarray(source, source + count), this.used);
      this.used += count;
      source += count;
      if (this.used === this.buffer.byteLength) this.flush();
    }
  }

  finish(): void {
    this.flush();
  }

  private flush(): void {
    if (this.used === 0) return;
    const payload = new Uint8Array(
      FORK_REFERENCE_SEGMENT_HEADER_SIZE + this.used,
    );
    const view = new DataView(payload.buffer);
    view.setUint32(0, KFRS_MAGIC, true);
    view.setUint16(4, FORK_REFERENCE_TRANSACTION_VERSION, true);
    view.setUint16(6, FORK_REFERENCE_SEGMENT_HEADER_SIZE, true);
    view.setUint16(8, this.section, true);
    view.setUint16(10, WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS, true);
    view.setUint32(12, 0, true);
    view.setBigUint64(16, this.state.ordinal, true);
    view.setBigUint64(24, this.logicalOffset, true);
    view.setUint32(32, this.used, true);
    view.setUint32(36, 0, true);
    payload.set(this.buffer.subarray(0, this.used), FORK_REFERENCE_SEGMENT_HEADER_SIZE);
    this.arena.appendRecord({
      kind: ForkModuleStateRecordKind.ReferenceRecipeSegment,
      activationId: 0,
      ownerId: this.ownerId,
      payload,
    });
    this.logicalOffset = addU64(
      this.logicalOffset,
      BigInt(this.used),
      "fork reference section offset",
    );
    this.state.ordinal = addU64(
      this.state.ordinal,
      1n,
      "fork reference segment ordinal",
    );
    this.used = 0;
  }
}

/**
 * Stream canonical production KFRV v2 records directly into the KFMS arena.
 *
 * The transaction already assigns dense recipe IDs as values are discovered,
 * so production must not sort/remap the graph or manufacture an all-node root
 * list merely to serialize it.
 */
export function appendSegmentedForkReferenceTransaction(
  arena: ForkModuleStateArena,
  ownerId: number,
  nodes: ForkReferenceSequence<ForkReferenceRecipeEntry>,
  vectors: ForkReferenceSequence<ForkReferenceVector>,
  options: ForkReferenceSegmentEncodingOptions = {},
): Uint8Array {
  assertOwner(ownerId);
  const segmentDataBytes =
    options.segmentDataBytes ?? DEFAULT_FORK_REFERENCE_SEGMENT_DATA_BYTES;
  if (
    !Number.isInteger(segmentDataBytes)
    || segmentDataBytes <= 0
    || segmentDataBytes > MAX_U32 - FORK_REFERENCE_SEGMENT_HEADER_SIZE
  ) {
    throw new RangeError(
      `fork reference segment data size ${segmentDataBytes} is invalid`,
    );
  }
  validateCanonicalCapture(nodes, vectors);
  const totals = computeSectionTotals(nodes, vectors);
  const state: SegmentState = { ordinal: 0n };

  const nodeWriter = new SegmentWriter(
    arena,
    ownerId,
    ReferenceSection.Nodes,
    state,
    segmentDataBytes,
  );
  let edgeStart = 0n;
  let scalarStart = 0n;
  const nodeRecord = new Uint8Array(FORK_REFERENCE_NODE_RECORD_SIZE);
  for (const { node } of nodes) {
    nodeRecord.fill(0);
    const edges = nodeEdges(node);
    const scalars = nodeScalars(node);
    encodeNodeRecordV2(
      new DataView(nodeRecord.buffer),
      node,
      edgeStart,
      BigInt(edges.length),
      scalarStart,
      BigInt(scalars.byteLength),
    );
    nodeWriter.write(nodeRecord);
    edgeStart = addU64(edgeStart, BigInt(edges.length), "fork reference edge count");
    scalarStart = addU64(
      scalarStart,
      BigInt(scalars.byteLength),
      "fork reference scalar byte count",
    );
  }
  nodeWriter.finish();

  const u32 = new Uint8Array(4);
  const u32View = new DataView(u32.buffer);
  const edgeWriter = new SegmentWriter(
    arena,
    ownerId,
    ReferenceSection.Edges,
    state,
    segmentDataBytes,
  );
  for (const { node } of nodes) {
    for (const edge of nodeEdges(node)) {
      u32View.setUint32(0, edge, true);
      edgeWriter.write(u32);
    }
  }
  edgeWriter.finish();

  const scalarWriter = new SegmentWriter(
    arena,
    ownerId,
    ReferenceSection.Scalars,
    state,
    segmentDataBytes,
  );
  for (const { node } of nodes) scalarWriter.write(nodeScalars(node));
  scalarWriter.finish();

  const vectorIndexWriter = new SegmentWriter(
    arena,
    ownerId,
    ReferenceSection.VectorIndex,
    state,
    segmentDataBytes,
  );
  const vectorIndex = new Uint8Array(FORK_REFERENCE_VECTOR_INDEX_SIZE);
  const vectorIndexView = new DataView(vectorIndex.buffer);
  let vectorEntryStart = 0n;
  for (let ordinal = 1; ordinal < vectors.length; ordinal++) {
    const vector = requiredDirectoryEntry(
      vectors,
      ordinal,
      "fork reference vector",
    );
    vectorIndexView.setBigUint64(0, vectorEntryStart, true);
    vectorIndexView.setBigUint64(8, BigInt(vector.length), true);
    vectorIndexWriter.write(vectorIndex);
    vectorEntryStart = addU64(
      vectorEntryStart,
      BigInt(vector.length),
      "fork reference vector entry count",
    );
  }
  vectorIndexWriter.finish();

  const vectorEntryWriter = new SegmentWriter(
    arena,
    ownerId,
    ReferenceSection.VectorEntries,
    state,
    segmentDataBytes,
  );
  for (let ordinal = 1; ordinal < vectors.length; ordinal++) {
    for (const recipeId of requiredDirectoryEntry(
      vectors,
      ordinal,
      "fork reference vector",
    )) {
      u32View.setUint32(0, recipeId, true);
      vectorEntryWriter.write(u32);
    }
  }
  vectorEntryWriter.finish();

  const manifest = encodeManifest(
    state.ordinal,
    BigInt(nodes.length),
    BigInt(vectors.length - 1),
    totals,
  );
  // WHY: the manifest is the transaction commit point. A failed segment
  // allocation leaves no authoritative KFRV record, and arena sealing rejects
  // the incomplete stream instead of exposing a truncated graph to a child.
  arena.appendRecord({
    kind: ForkModuleStateRecordKind.ReferenceRecipe,
    activationId: 0,
    ownerId,
    payload: manifest,
  });
  return manifest;
}

/**
 * Test/helper encoder that preserves record segmentation without allocating a
 * whole KFRV transaction. Production capture writes to a real KFMS arena.
 */
export function encodeSegmentedForkReferenceRecords(
  ownerId: number,
  nodes: ForkReferenceSequence<ForkReferenceRecipeEntry>,
  vectors: ForkReferenceSequence<ForkReferenceVector>,
  options: ForkReferenceSegmentEncodingOptions = {},
): ForkModuleStateRecord[] {
  const records: ForkModuleStateRecord[] = [];
  const sink = {
    appendRecord(record: ForkModuleStateRecord): void {
      records.push({
        ...record,
        payload: record.payload.slice(),
      });
    },
  } as Pick<ForkModuleStateArena, "appendRecord">;
  appendSegmentedForkReferenceTransaction(
    sink as ForkModuleStateArena,
    ownerId,
    nodes,
    vectors,
    options,
  );
  return records;
}

function computeSectionTotals(
  nodes: ForkReferenceSequence<ForkReferenceRecipeEntry>,
  vectors: ForkReferenceSequence<ForkReferenceVector>,
): SectionTotals {
  let edgeCount = 0n;
  let scalarBytes = 0n;
  for (const { node } of nodes) {
    edgeCount = addU64(
      edgeCount,
      BigInt(nodeEdges(node).length),
      "fork reference edge count",
    );
    scalarBytes = addU64(
      scalarBytes,
      BigInt(nodeScalars(node).byteLength),
      "fork reference scalar byte count",
    );
  }
  let vectorEntries = 0n;
  for (let ordinal = 1; ordinal < vectors.length; ordinal++) {
    vectorEntries = addU64(
      vectorEntries,
      BigInt(requiredDirectoryEntry(
        vectors,
        ordinal,
        "fork reference vector",
      ).length),
      "fork reference vector entry count",
    );
  }
  return {
    nodes: multiplyU64(
      BigInt(nodes.length),
      BigInt(FORK_REFERENCE_NODE_RECORD_SIZE),
      "fork reference node bytes",
    ),
    edges: multiplyU64(edgeCount, 4n, "fork reference edge bytes"),
    scalars: scalarBytes,
    vectorIndex: multiplyU64(
      BigInt(vectors.length - 1),
      BigInt(FORK_REFERENCE_VECTOR_INDEX_SIZE),
      "fork reference vector-index bytes",
    ),
    vectorEntries: multiplyU64(
      vectorEntries,
      4n,
      "fork reference vector-entry bytes",
    ),
  };
}

function encodeManifest(
  segmentCount: bigint,
  nodeCount: bigint,
  vectorCount: bigint,
  totals: SectionTotals,
): Uint8Array {
  const totalLogical = sectionTotalsArray(totals).reduce(
    (sum, value) => addU64(sum, value, "fork reference logical bytes"),
    0n,
  );
  const manifest = new Uint8Array(FORK_REFERENCE_MANIFEST_SIZE);
  const view = new DataView(manifest.buffer);
  view.setUint32(0, KFRV_MAGIC, true);
  view.setUint16(4, FORK_REFERENCE_TRANSACTION_VERSION, true);
  view.setUint16(6, FORK_REFERENCE_MANIFEST_SIZE, true);
  view.setUint32(8, FORK_REFERENCE_MANIFEST_FLAG_SEALED, true);
  view.setUint32(12, FORK_REFERENCE_NODE_RECORD_SIZE, true);
  view.setUint32(16, FORK_REFERENCE_VECTOR_INDEX_SIZE, true);
  view.setUint32(20, 0, true);
  view.setBigUint64(24, segmentCount, true);
  view.setBigUint64(32, nodeCount, true);
  view.setBigUint64(40, vectorCount, true);
  view.setBigUint64(48, totals.nodes, true);
  view.setBigUint64(56, totals.edges, true);
  view.setBigUint64(64, totals.scalars, true);
  view.setBigUint64(72, totals.vectorIndex, true);
  view.setBigUint64(80, totals.vectorEntries, true);
  view.setBigUint64(88, totalLogical, true);
  return manifest;
}

/**
 * Validate and decode the production KFRV v2 stream without concatenating it.
 *
 * Structural and semantic validation completes before graph nodes or reference
 * vectors are materialized. This prevents malformed guest bytes from driving
 * partial Wasm reconstruction.
 */
export function decodeSegmentedForkReferenceTransaction(
  records: readonly ForkModuleStateRecordView[],
  ownerId: number,
): DecodedSegmentedForkReferenceTransaction {
  const parsed = parseSegmentedForkReferenceTransaction(records, ownerId);
  const semantics = validateReferenceSemantics(parsed);
  const graph = materializeReferenceGraph(parsed);
  const vectors = materializeReferenceVectors(parsed, semantics);
  const identity = Object.freeze({});
  return Object.freeze({
    identity,
    graph,
    vectors,
    vectorIntern: semantics.vectorIntern,
  });
}

function materializeReferenceGraph(
  parsed: ParsedSegmentedForkReferenceTransaction,
): DecodedSegmentedForkReferenceTransaction["graph"] {
  const nodeReader = requiredSection(parsed, ReferenceSection.Nodes).reader();
  const edgeReader = requiredSection(parsed, ReferenceSection.Edges).reader();
  const scalarReader = requiredSection(parsed, ReferenceSection.Scalars).reader();
  const recordBytes = new Uint8Array(FORK_REFERENCE_NODE_RECORD_SIZE);
  const nodes = new PagedForkReferenceDirectory<ForkReferenceRecipeEntry>();

  for (let id = 0; id < parsed.manifest.nodeCount; id++) {
    nodeReader.readInto(recordBytes);
    const header = decodeNodeHeader(recordBytes, id);
    const edges: number[] = [];
    for (let edgeIndex = 0; edgeIndex < Number(header.edgeCount); edgeIndex++) {
      edges.push(edgeReader.readU32());
    }
    const scalars = scalarReader.readBytes(Number(header.scalarLength));
    nodes.push(Object.freeze({
      id,
      node: decodeRecipeNode(header, edges, scalars, id),
    }));
  }
  return Object.freeze({
    // Recipe IDs are direct roots from frames/globals/tables. A redundant
    // all-node root vector would double graph bookkeeping and force remapping.
    roots: Object.freeze([]),
    nodes,
  });
}

function materializeReferenceVectors(
  parsed: ParsedSegmentedForkReferenceTransaction,
  semantics: ValidatedReferenceSemantics,
): ForkReferenceDirectory<ForkReferenceVector> {
  const reader = requiredSection(
    parsed,
    ReferenceSection.VectorEntries,
  ).reader();
  const vectors = new PagedForkReferenceDirectory<ForkReferenceVector>();
  vectors.push(PagedForkReferenceVector.empty);
  for (const range of semantics.vectors) {
    const builder = new ForkReferenceVectorBuilder(range.length);
    for (let index = 0; index < range.length; index++) {
      builder.append(reader.readU32());
    }
    vectors.push(builder.finish());
  }
  reader.requireEnd("fork reference vector materialization");
  return vectors;
}

function decodeRecipeNode(
  header: DecodedNodeHeader,
  edges: readonly number[],
  scalars: Uint8Array,
  id: number,
): ForkReferenceRecipeNode {
  switch (header.kind) {
    case WireNodeKind.Null:
      return Object.freeze({ kind: "null" });
    case WireNodeKind.Funcref:
      return Object.freeze({
        kind: "funcref",
        moduleActivation: header.first,
        functionOrdinal: header.second,
      });
    case WireNodeKind.Externref:
      return Object.freeze({
        kind: "externref",
        handle: decodeHandle(header.first, header.second, id),
      });
    case WireNodeKind.Exnref:
      return Object.freeze({
        kind: "exnref",
        moduleActivation: header.first,
        tagOrdinal: header.second,
        layoutId: header.third,
        scalars,
        payloads: Object.freeze([...edges]),
      });
    case WireNodeKind.I31:
      return Object.freeze({ kind: "i31", value: header.first | 0 });
    case WireNodeKind.Struct:
      return Object.freeze({
        kind: "struct",
        moduleActivation: header.first,
        typeOrdinal: header.second,
        layoutId: header.third,
        scalars,
        fields: Object.freeze([...edges]),
      });
    case WireNodeKind.Array:
      return Object.freeze({
        kind: "array",
        moduleActivation: header.first,
        typeOrdinal: header.second,
        layoutId: header.third,
        scalars,
        elements: Object.freeze([...edges]),
      });
    case WireNodeKind.StaticRoot:
      return Object.freeze({
        kind: "static-root",
        moduleActivation: header.first,
        staticRootOrdinal: header.second,
      });
  }
}

function validateCanonicalCapture(
  nodes: ForkReferenceSequence<ForkReferenceRecipeEntry>,
  vectors: ForkReferenceSequence<ForkReferenceVector>,
): void {
  if (nodes.length === 0 || nodes.length > MAX_U32_DIRECTORY_LENGTH) {
    throw new RangeError(`fork reference node count ${nodes.length} is invalid`);
  }
  if (vectors.length === 0 || vectors.length - 1 > MAX_U32) {
    throw new RangeError(`fork reference vector count ${vectors.length - 1} is invalid`);
  }
  if (requiredDirectoryEntry(vectors, 0, "fork reference vector").length !== 0) {
    throw new Error("fork reference vector zero is not the empty sentinel");
  }
  let id = 0;
  for (const entry of nodes) {
    if (entry.id !== id) {
      throw new Error(
        `fork reference recipe node ${entry.id} is out of canonical order at ${id}`,
      );
    }
    if ((id === 0) !== (entry.node.kind === "null")) {
      throw new Error(
        id === 0
          ? "fork reference recipe node zero is not null"
          : `fork reference recipe node ${id} duplicates null`,
      );
    }
    validateCaptureNode(entry.node, id, nodes.length);
    id++;
  }
  const intern: MutableForkReferenceVectorInternIndex = new Map();
  for (let ordinal = 1; ordinal < vectors.length; ordinal++) {
    const vector = requiredDirectoryEntry(
      vectors,
      ordinal,
      "fork reference vector",
    );
    if (vector.length === 0) {
      throw new Error(
        `fork reference vector ${ordinal} duplicates the empty sentinel`,
      );
    }
    vector.forEach((recipeId, index) => {
      assertRecipeId(recipeId, `fork reference vector ${ordinal} entry ${index}`);
      if (recipeId >= nodes.length) {
        throw new Error(
          `fork reference vector ${ordinal} entry ${index} names `
          + `missing recipe ${recipeId}`,
        );
      }
    });
    const key = forkReferenceVectorInternKey(vector);
    for (const previous of intern.get(key) ?? []) {
      if (forkReferenceVectorsEqual(
        requiredDirectoryEntry(vectors, previous, "fork reference vector"),
        vector,
      )) {
        throw new Error(
          `fork reference vector ${ordinal} duplicates canonical vector ${previous}`,
        );
      }
    }
    let bucket = intern.get(key);
    if (!bucket) {
      bucket = new PagedForkReferenceDirectory<number>();
      intern.set(key, bucket);
    }
    bucket.push(ordinal);
  }
}

function validateCaptureNode(
  node: ForkReferenceRecipeNode,
  id: number,
  nodeCount: number,
): void {
  const context = `fork reference node ${id}`;
  switch (node.kind) {
    case "null":
      return;
    case "funcref":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.functionOrdinal, `${context} function ordinal`);
      return;
    case "externref":
      if (!Number.isInteger(node.handle) || node.handle <= 0 || node.handle > MAX_U32) {
        throw new RangeError(`${context} externref handle is invalid`);
      }
      return;
    case "i31":
      if (
        !Number.isInteger(node.value)
        || node.value < -0x4000_0000
        || node.value > 0x3fff_ffff
      ) {
        throw new RangeError(`${context} has invalid i31 value ${node.value}`);
      }
      return;
    case "exnref":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.tagOrdinal, `${context} tag ordinal`);
      assertU32(node.layoutId ?? 0, `${context} layout id`);
      validateCaptureAggregate(node.payloads, node.scalars, context, nodeCount);
      return;
    case "struct":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.typeOrdinal, `${context} type ordinal`);
      assertU32(node.layoutId ?? 0, `${context} layout id`);
      validateCaptureAggregate(node.fields, node.scalars, context, nodeCount);
      return;
    case "array":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.typeOrdinal, `${context} type ordinal`);
      assertU32(node.layoutId ?? 0, `${context} layout id`);
      validateCaptureAggregate(node.elements, node.scalars, context, nodeCount);
      return;
    case "static-root":
      assertU32(node.moduleActivation, `${context} module activation`);
      assertU32(node.staticRootOrdinal, `${context} static-root ordinal`);
      return;
  }
}

function validateCaptureAggregate(
  edges: readonly number[],
  scalars: Uint8Array | undefined,
  context: string,
  nodeCount: number,
): void {
  if (edges.length > MAX_U32) {
    throw new RangeError(`${context} edge count exceeds u32`);
  }
  if (scalars !== undefined && !(scalars instanceof Uint8Array)) {
    throw new TypeError(`${context} scalar payload is not a Uint8Array`);
  }
  edges.forEach((recipeId, index) => {
    assertRecipeId(recipeId, `${context} edge ${index}`);
    if (recipeId >= nodeCount) {
      throw new Error(`${context} edge ${index} names missing recipe ${recipeId}`);
    }
  });
}

function encodeNodeRecordV2(
  view: DataView,
  node: ForkReferenceRecipeNode,
  edgeStart: bigint,
  edgeCount: bigint,
  scalarStart: bigint,
  scalarLength: bigint,
): void {
  let kind: WireNodeKind;
  let first = 0;
  let second = 0;
  let third = 0;
  switch (node.kind) {
    case "null":
      kind = WireNodeKind.Null;
      break;
    case "funcref":
      kind = WireNodeKind.Funcref;
      first = node.moduleActivation;
      second = node.functionOrdinal;
      break;
    case "externref":
      kind = WireNodeKind.Externref;
      first = node.handle >>> 0;
      second = Math.floor(node.handle / 0x1_0000_0000);
      break;
    case "exnref":
      kind = WireNodeKind.Exnref;
      first = node.moduleActivation;
      second = node.tagOrdinal;
      third = node.layoutId ?? 0;
      break;
    case "i31":
      kind = WireNodeKind.I31;
      first = node.value >>> 0;
      break;
    case "struct":
      kind = WireNodeKind.Struct;
      first = node.moduleActivation;
      second = node.typeOrdinal;
      third = node.layoutId ?? 0;
      break;
    case "array":
      kind = WireNodeKind.Array;
      first = node.moduleActivation;
      second = node.typeOrdinal;
      third = node.layoutId ?? 0;
      break;
    case "static-root":
      kind = WireNodeKind.StaticRoot;
      first = node.moduleActivation;
      second = node.staticRootOrdinal;
      break;
  }
  const aggregate =
    node.kind === "exnref" || node.kind === "struct" || node.kind === "array";
  view.setUint8(0, kind);
  view.setUint8(1, 0);
  view.setUint16(2, 0, true);
  view.setUint32(4, first, true);
  view.setUint32(8, second, true);
  view.setUint32(12, third, true);
  view.setBigUint64(16, aggregate ? edgeStart : 0n, true);
  view.setBigUint64(24, aggregate ? edgeCount : 0n, true);
  view.setBigUint64(32, aggregate ? scalarStart : 0n, true);
  view.setBigUint64(40, aggregate ? scalarLength : 0n, true);
}

function nodeEdges(node: ForkReferenceRecipeNode): readonly number[] {
  switch (node.kind) {
    case "exnref":
      return node.payloads;
    case "struct":
      return node.fields;
    case "array":
      return node.elements;
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      return [];
  }
}

function nodeScalars(node: ForkReferenceRecipeNode): Uint8Array {
  switch (node.kind) {
    case "exnref":
    case "struct":
    case "array":
      return node.scalars ?? new Uint8Array();
    case "null":
    case "funcref":
    case "externref":
    case "i31":
    case "static-root":
      return new Uint8Array();
  }
}

/** Pure u64 helper used by boundary tests without allocating a 4-GiB buffer. */
export function advanceForkReferenceLogicalOffset(
  offset: bigint,
  byteLength: number,
): bigint {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError("fork reference logical byte length is invalid");
  }
  return addU64(offset, BigInt(byteLength), "fork reference logical offset");
}

function assertRecipeId(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new RangeError(`${context} ${value} is not a u32 recipe id`);
  }
}
