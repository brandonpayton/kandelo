import {
  ForkModuleStateRecordKind,
  type ForkModuleStateRecordView,
} from "./fork-module-state";
import {
  WPK_FORK_REFERENCE_NODE_RECORD_SIZE,
  WPK_FORK_REFERENCE_SECTION_EDGES,
  WPK_FORK_REFERENCE_SECTION_NODES,
  WPK_FORK_REFERENCE_SECTION_SCALARS,
  WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES,
  WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX,
  WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE,
  WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS,
  WPK_FORK_REFERENCE_SEGMENT_MAGIC,
  WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED,
  WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS,
  WPK_FORK_REFERENCE_TRANSACTION_MAGIC,
  WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE,
  WPK_FORK_REFERENCE_TRANSACTION_OWNER,
  WPK_FORK_REFERENCE_TRANSACTION_VERSION,
  WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE,
} from "./generated/abi";

/**
 * Staying wire-parse core for the process reference-recipe transaction.
 *
 * This module holds the read-only KFRV v2 parse, semantic validation, and the
 * externref-handle scan the Kernel-Worker process owner needs before a fork
 * child is launched. It deliberately depends on nothing from the deletable JS
 * reference engine (`fork-reference-transaction.ts` /
 * `fork-activation-registry.ts`) and does not materialize graph or vector
 * objects (which pull in `fork-reference-recipes.ts`). The encode side and the
 * graph/vector materializers live in `fork-reference-segments.ts` and import
 * the shared primitives from here.
 */

/**
 * Owner id local to the ReferenceRecipe record kind. One process fork has one
 * identity space shared by main-module frames, side-module frames, globals, and
 * tables, so aliases never become module-local by accident.
 */
export const FORK_REFERENCE_TRANSACTION_OWNER_ID =
  WPK_FORK_REFERENCE_TRANSACTION_OWNER;

/**
 * The reserved `moduleActivation` sentinel a decoded reference node carries when
 * its exnref is host-owned (a host/JSTag exception) rather than owned by a guest
 * activation. A wire-level graph sentinel, so it lives with the other reference
 * wire constants; the deletable engine re-exports it for its existing importers.
 */
export const FORK_HOST_EXCEPTION_ACTIVATION_ID = 0xffff_ffff;

export const FORK_REFERENCE_TRANSACTION_VERSION =
  WPK_FORK_REFERENCE_TRANSACTION_VERSION;
export const FORK_REFERENCE_MANIFEST_SIZE =
  WPK_FORK_REFERENCE_TRANSACTION_MANIFEST_SIZE;
export const FORK_REFERENCE_SEGMENT_HEADER_SIZE =
  WPK_FORK_REFERENCE_SEGMENT_HEADER_SIZE;
export const FORK_REFERENCE_NODE_RECORD_SIZE =
  WPK_FORK_REFERENCE_NODE_RECORD_SIZE;
export const FORK_REFERENCE_VECTOR_INDEX_SIZE =
  WPK_FORK_REFERENCE_VECTOR_INDEX_SIZE;

export const KFRV_MAGIC = littleEndianMagic(WPK_FORK_REFERENCE_TRANSACTION_MAGIC);
export const KFRS_MAGIC = littleEndianMagic(WPK_FORK_REFERENCE_SEGMENT_MAGIC);
export const FORK_REFERENCE_MANIFEST_FLAG_SEALED =
  WPK_FORK_REFERENCE_TRANSACTION_FLAG_SEALED;
const FORK_REFERENCE_MANIFEST_KNOWN_FLAGS =
  WPK_FORK_REFERENCE_TRANSACTION_KNOWN_FLAGS;

export const MAX_U64 = 0xffff_ffff_ffff_ffffn;
export const MAX_U32 = 0xffff_ffff;
export const MAX_U32_DIRECTORY_LENGTH = 0x1_0000_0000;
export const VECTOR_PAGE_ENTRIES = 4096;

export enum ReferenceSection {
  Nodes = WPK_FORK_REFERENCE_SECTION_NODES,
  Edges = WPK_FORK_REFERENCE_SECTION_EDGES,
  Scalars = WPK_FORK_REFERENCE_SECTION_SCALARS,
  VectorIndex = WPK_FORK_REFERENCE_SECTION_VECTOR_INDEX,
  VectorEntries = WPK_FORK_REFERENCE_SECTION_VECTOR_ENTRIES,
}

const SECTION_COUNT = 5;

export enum WireNodeKind {
  Null = 0,
  Funcref = 1,
  Externref = 2,
  Exnref = 3,
  I31 = 4,
  Struct = 5,
  Array = 6,
  StaticRoot = 7,
}

/**
 * Random-access paged directory whose index namespace is the complete u32.
 *
 * Unlike a JavaScript Array, it can represent 2^32 entries (indices zero
 * through 0xffff_ffff) without one engine-level contiguous backing store.
 */
export interface ForkReferenceDirectory<T> extends Iterable<T> {
  readonly length: number;
  get(index: number): T | undefined;
  has(index: number): boolean;
  forEach(callback: (value: T, index: number) => void): void;
  some(predicate: (value: T, index: number) => boolean): boolean;
}

export type ForkReferenceSequence<T> =
  | ForkReferenceDirectory<T>
  | readonly T[];

export class PagedForkReferenceDirectory<T>
  implements ForkReferenceDirectory<T>
{
  private pages = new Map<number, Array<T | undefined>>();
  private count = 0;

  get length(): number {
    return this.count;
  }

  get(index: number): T | undefined {
    if (
      !Number.isInteger(index)
      || index < 0
      || index > MAX_U32
      || index >= this.count
    ) {
      return undefined;
    }
    return this.pages.get(Math.floor(index / VECTOR_PAGE_ENTRIES))?.[
      index % VECTOR_PAGE_ENTRIES
    ];
  }

  has(index: number): boolean {
    if (
      !Number.isInteger(index)
      || index < 0
      || index > MAX_U32
      || index >= this.count
    ) {
      return false;
    }
    const page = this.pages.get(Math.floor(index / VECTOR_PAGE_ENTRIES));
    return !!page && (index % VECTOR_PAGE_ENTRIES) in page;
  }

  push(value: T): number {
    if (this.count >= MAX_U32_DIRECTORY_LENGTH) {
      throw new RangeError("fork reference u32 directory is exhausted");
    }
    const index = this.count;
    const pageIndex = Math.floor(index / VECTOR_PAGE_ENTRIES);
    const page = this.pages.get(pageIndex) ?? [];
    page[index % VECTOR_PAGE_ENTRIES] = value;
    this.pages.set(pageIndex, page);
    this.count++;
    return this.count;
  }

  set(index: number, value: T): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) {
      throw new RangeError(`fork reference directory index ${index} is out of bounds`);
    }
    const pageIndex = Math.floor(index / VECTOR_PAGE_ENTRIES);
    const page = this.pages.get(pageIndex) ?? [];
    page[index % VECTOR_PAGE_ENTRIES] = value;
    this.pages.set(pageIndex, page);
  }

  clear(): void {
    this.pages.clear();
    this.count = 0;
  }

  forEach(callback: (value: T, index: number) => void): void {
    let index = 0;
    const pageCount = Math.ceil(this.count / VECTOR_PAGE_ENTRIES);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = this.pages.get(pageIndex);
      if (!page) {
        throw new Error(
          `fork reference directory has no page ${pageIndex}`,
        );
      }
      const count = Math.min(page.length, this.count - index);
      for (let local = 0; local < count; local++, index++) {
        if (!(local in page)) {
          throw new Error(`fork reference directory has a hole at ${index}`);
        }
        callback(page[local]!, index);
      }
    }
    if (index !== this.count) {
      throw new Error(`fork reference directory ends at ${index}; expected ${this.count}`);
    }
  }

  some(predicate: (value: T, index: number) => boolean): boolean {
    for (const [index, value] of this.indexed()) {
      if (predicate(value, index)) return true;
    }
    return false;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const [, value] of this.indexed()) yield value;
  }

  private *indexed(): IterableIterator<readonly [number, T]> {
    let index = 0;
    const pageCount = Math.ceil(this.count / VECTOR_PAGE_ENTRIES);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const page = this.pages.get(pageIndex);
      if (!page) {
        throw new Error(
          `fork reference directory has no page ${pageIndex}`,
        );
      }
      const count = Math.min(page.length, this.count - index);
      for (let local = 0; local < count; local++, index++) {
        if (!(local in page)) {
          throw new Error(`fork reference directory has a hole at ${index}`);
        }
        yield [index, page[local]!] as const;
      }
    }
    if (index !== this.count) {
      throw new Error(`fork reference directory ends at ${index}; expected ${this.count}`);
    }
  }
}

export type ForkReferenceVectorInternIndex =
  ReadonlyMap<string, ForkReferenceDirectory<number>>;

export type MutableForkReferenceVectorInternIndex =
  Map<string, PagedForkReferenceDirectory<number>>;

export interface ForkReferenceSegmentEncodingOptions {
  /**
   * Transient writer target, not a total-state limit. Smaller values are useful
   * for boundary tests; production uses a near-1-MiB bounded copy window.
   */
  readonly segmentDataBytes?: number;
}

export interface SectionTotals {
  readonly nodes: bigint;
  readonly edges: bigint;
  readonly scalars: bigint;
  readonly vectorIndex: bigint;
  readonly vectorEntries: bigint;
}

export interface ReferenceSegment {
  readonly ordinal: bigint;
  readonly offset: bigint;
  readonly data: Uint8Array;
}

const SEGMENT_DIRECTORY_PAGE_ENTRIES = 4096n;

/**
 * Segment metadata uses bigint indexes as well as u64 wire ordinals.
 *
 * A JavaScript Array (including a paged directory addressed by `number`) would
 * reintroduce a 2^32-segment ceiling even though KFRV v2 deliberately carries
 * u64 segment counts. Pages remain ordinary small arrays; only their sparse
 * page keys and the logical length are bigint.
 */
export class BigIntPagedDirectory<T> implements Iterable<T> {
  private readonly pages = new Map<bigint, Array<T | undefined>>();
  private count = 0n;

  get length(): bigint {
    return this.count;
  }

  get(index: bigint): T | undefined {
    if (index < 0n || index >= this.count) return undefined;
    const page = this.pages.get(index / SEGMENT_DIRECTORY_PAGE_ENTRIES);
    return page?.[Number(index % SEGMENT_DIRECTORY_PAGE_ENTRIES)];
  }

  push(value: T): void {
    if (this.count === MAX_U64) {
      throw new RangeError("fork reference segment directory exceeds u64");
    }
    const pageIndex = this.count / SEGMENT_DIRECTORY_PAGE_ENTRIES;
    let page = this.pages.get(pageIndex);
    if (!page) {
      page = [];
      this.pages.set(pageIndex, page);
    }
    page[Number(this.count % SEGMENT_DIRECTORY_PAGE_ENTRIES)] = value;
    this.count++;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let index = 0n; index < this.count; index++) {
      const value = this.get(index);
      if (value === undefined) {
        throw new Error(`fork reference segment directory has a hole at ${index}`);
      }
      yield value;
    }
  }
}

export interface ParsedReferenceManifest {
  readonly segmentCount: bigint;
  readonly nodeCount: number;
  readonly vectorCount: number;
  readonly totals: SectionTotals;
}

export interface ParsedSegmentedForkReferenceTransaction {
  readonly manifest: ParsedReferenceManifest;
  readonly sections: ReadonlyMap<ReferenceSection, SegmentedSection>;
}

export interface ValidatedVectorRange {
  readonly start: bigint;
  readonly length: number;
}

export interface ValidatedReferenceSemantics {
  readonly vectors: ForkReferenceDirectory<ValidatedVectorRange>;
  readonly vectorIntern: ForkReferenceVectorInternIndex;
}

/**
 * One logical section backed by ordered KFMS record payloads.
 *
 * `totalBytes` and offsets remain bigint all the way through validation. A
 * transaction may therefore cross the 4-GiB boundary without requiring a
 * JavaScript ArrayBuffer of that size.
 */
export class SegmentedSection {
  constructor(
    readonly segments: BigIntPagedDirectory<ReferenceSegment>,
    readonly totalBytes: bigint,
  ) {}

  reader(): SegmentedSectionReader {
    return new SegmentedSectionReader(this);
  }

  readU32At(offset: bigint): number {
    if (offset < 0n || addU64(offset, 4n, "fork reference u32 end") > this.totalBytes) {
      throw new Error(`fork reference section offset ${offset} is out of bounds`);
    }
    return (
      this.byteAt(offset)
      | (this.byteAt(offset + 1n) << 8)
      | (this.byteAt(offset + 2n) << 16)
      | (this.byteAt(offset + 3n) << 24)
    ) >>> 0;
  }

  private byteAt(offset: bigint): number {
    let low = 0n;
    let high = this.segments.length;
    while (low < high) {
      const middle = low + ((high - low) >> 1n);
      const segment = this.segments.get(middle)!;
      const end = segment.offset + BigInt(segment.data.byteLength);
      if (offset < segment.offset) {
        high = middle;
      } else if (offset >= end) {
        low = middle + 1n;
      } else {
        return segment.data[Number(offset - segment.offset)]!;
      }
    }
    throw new Error(`fork reference section offset ${offset} has no segment`);
  }
}

export class SegmentedSectionReader {
  private segmentIndex = 0n;
  private localOffset = 0;
  private consumed = 0n;
  private readonly numberBytes = new Uint8Array(8);
  private readonly numberView = new DataView(this.numberBytes.buffer);

  constructor(private readonly section: SegmentedSection) {}

  get position(): bigint {
    return this.consumed;
  }

  readInto(target: Uint8Array): void {
    let targetOffset = 0;
    while (targetOffset < target.byteLength) {
      const segment = this.section.segments.get(this.segmentIndex);
      if (!segment) {
        throw new Error(
          `fork reference section is truncated at logical byte ${this.consumed}`,
        );
      }
      const available = segment.data.byteLength - this.localOffset;
      const count = Math.min(available, target.byteLength - targetOffset);
      target.set(
        segment.data.subarray(this.localOffset, this.localOffset + count),
        targetOffset,
      );
      this.advance(count, segment);
      targetOffset += count;
    }
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > MAX_U32) {
      throw new RangeError(`fork reference byte count ${length} is not a u32`);
    }
    const bytes = new Uint8Array(length);
    this.readInto(bytes);
    return bytes;
  }

  readU32(): number {
    this.readInto(this.numberBytes.subarray(0, 4));
    return this.numberView.getUint32(0, true);
  }

  skip(length: bigint): void {
    if (length < 0n) {
      throw new RangeError("fork reference skip length is negative");
    }
    let remaining = length;
    while (remaining !== 0n) {
      const segment = this.section.segments.get(this.segmentIndex);
      if (!segment) {
        throw new Error(
          `fork reference section is truncated at logical byte ${this.consumed}`,
        );
      }
      const available = segment.data.byteLength - this.localOffset;
      const count = remaining < BigInt(available)
        ? Number(remaining)
        : available;
      this.advance(count, segment);
      remaining -= BigInt(count);
    }
  }

  requireEnd(context: string): void {
    if (this.consumed !== this.section.totalBytes) {
      throw new Error(
        `${context} consumed ${this.consumed} bytes; `
        + `section contains ${this.section.totalBytes}`,
      );
    }
  }

  private advance(count: number, segment: ReferenceSegment): void {
    this.localOffset += count;
    this.consumed += BigInt(count);
    if (this.localOffset === segment.data.byteLength) {
      this.segmentIndex++;
      this.localOffset = 0;
    }
  }
}

/**
 * Scan only opaque externref handles for the pre-launch process owner.
 *
 * This uses the exact production parser and semantic validator but deliberately
 * avoids constructing graph/vector objects or retaining a whole wire image.
 */
export function scanSegmentedForkReferenceExternrefHandles(
  records: readonly ForkModuleStateRecordView[],
  ownerId: number,
): ReadonlySet<number> {
  const parsed = parseSegmentedForkReferenceTransaction(records, ownerId);
  validateReferenceSemantics(parsed);
  const handles = new Set<number>();
  const reader = requiredSection(parsed, ReferenceSection.Nodes).reader();
  const recordBytes = new Uint8Array(FORK_REFERENCE_NODE_RECORD_SIZE);
  for (let id = 0; id < parsed.manifest.nodeCount; id++) {
    reader.readInto(recordBytes);
    const view = new DataView(recordBytes.buffer);
    if (view.getUint8(0) !== WireNodeKind.Externref) continue;
    handles.add(decodeHandle(view.getUint32(4, true), view.getUint32(8, true), id));
  }
  reader.requireEnd("fork reference node scan");
  return handles;
}

export function parseSegmentedForkReferenceTransaction(
  records: readonly ForkModuleStateRecordView[],
  ownerId: number,
): ParsedSegmentedForkReferenceTransaction {
  assertOwner(ownerId);
  const bySection = new Map<
    ReferenceSection,
    BigIntPagedDirectory<ReferenceSegment>
  >();
  const observed = new Map<ReferenceSection, bigint>();
  let selectedCount = 0n;
  let segmentCount = 0n;
  let manifestCount = 0;
  let manifest: ParsedReferenceManifest | undefined;
  let previousSection = 0;

  for (const record of records) {
    if (
      record.kind !== ForkModuleStateRecordKind.ReferenceRecipeSegment
      && record.kind !== ForkModuleStateRecordKind.ReferenceRecipe
    ) {
      continue;
    }
    const selectedIndex = selectedCount;
    selectedCount = addU64(
      selectedCount,
      1n,
      "fork reference record count",
    );
    if (record.activationId !== 0 || record.ownerId !== ownerId) {
      throw new Error(
        `fork reference record ${selectedIndex} has invalid process ownership `
        + `${record.activationId}:${record.ownerId}`,
      );
    }

    if (record.kind === ForkModuleStateRecordKind.ReferenceRecipe) {
      manifestCount++;
      if (manifestCount === 1) manifest = decodeManifest(record.payload);
      continue;
    }
    if (manifestCount !== 0) {
      throw new Error("fork reference segment follows its final manifest");
    }
    const segment = decodeSegment(record.payload, segmentCount);
    if (segment.section < previousSection) {
      throw new Error(
        `fork reference segment ${segmentCount} reorders section ${segment.section}`,
      );
    }
    previousSection = segment.section;
    const expectedOffset = observed.get(segment.section) ?? 0n;
    if (segment.offset !== expectedOffset) {
      throw new Error(
        `fork reference segment ${segmentCount} starts at ${segment.offset}; `
        + `expected ${expectedOffset} (gap, overlap, or duplicate)`,
      );
    }
    observed.set(
      segment.section,
      addU64(
        expectedOffset,
        BigInt(segment.data.byteLength),
        `fork reference section ${segment.section} bytes`,
      ),
    );
    let sectionSegments = bySection.get(segment.section);
    if (!sectionSegments) {
      sectionSegments = new BigIntPagedDirectory<ReferenceSegment>();
      bySection.set(segment.section, sectionSegments);
    }
    sectionSegments.push({
      ordinal: segmentCount,
      offset: segment.offset,
      data: segment.data,
    });
    segmentCount = addU64(
      segmentCount,
      1n,
      "fork reference segment count",
    );
  }

  if (selectedCount === 0n) {
    throw new Error("fork module state has no process reference transaction");
  }
  if (manifestCount !== 1 || manifest === undefined) {
    throw new Error(
      `fork module state has ${manifestCount} process reference manifests; `
      + "expected one",
    );
  }
  if (segmentCount !== manifest.segmentCount) {
    throw new Error(
      `fork reference manifest declares ${manifest.segmentCount} segments; `
      + `found ${segmentCount}`,
    );
  }

  const totals = sectionTotalsArray(manifest.totals);
  const sections = new Map<ReferenceSection, SegmentedSection>();
  for (let ordinal = 0; ordinal < SECTION_COUNT; ordinal++) {
    const section = (ordinal + 1) as ReferenceSection;
    const expected = totals[ordinal]!;
    const actual = observed.get(section) ?? 0n;
    if (actual !== expected) {
      throw new Error(
        `fork reference section ${section} contains ${actual} bytes; `
        + `manifest declares ${expected}`,
      );
    }
    sections.set(
      section,
      new SegmentedSection(
        bySection.get(section) ?? new BigIntPagedDirectory<ReferenceSegment>(),
        expected,
      ),
    );
  }
  return { manifest, sections };
}

function decodeManifest(payload: Uint8Array): ParsedReferenceManifest {
  if (payload.byteLength !== FORK_REFERENCE_MANIFEST_SIZE) {
    throw new Error(
      `fork reference manifest has ${payload.byteLength} bytes; `
      + `expected ${FORK_REFERENCE_MANIFEST_SIZE}`,
    );
  }
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  if (view.getUint32(0, true) !== KFRV_MAGIC) {
    throw new Error("fork reference manifest has invalid KFRV magic");
  }
  const version = view.getUint16(4, true);
  if (version !== FORK_REFERENCE_TRANSACTION_VERSION) {
    throw new Error(`unsupported fork reference transaction version ${version}`);
  }
  if (view.getUint16(6, true) !== FORK_REFERENCE_MANIFEST_SIZE) {
    throw new Error("fork reference manifest declares an invalid header size");
  }
  const flags = view.getUint32(8, true);
  if (
    flags !== FORK_REFERENCE_MANIFEST_FLAG_SEALED
    || (flags & ~FORK_REFERENCE_MANIFEST_KNOWN_FLAGS) !== 0
  ) {
    throw new Error(`fork reference manifest has invalid flags 0x${flags.toString(16)}`);
  }
  if (
    view.getUint32(12, true) !== FORK_REFERENCE_NODE_RECORD_SIZE
    || view.getUint32(16, true) !== FORK_REFERENCE_VECTOR_INDEX_SIZE
  ) {
    throw new Error("fork reference manifest declares invalid record sizes");
  }
  if (view.getUint32(20, true) !== 0) {
    throw new Error("fork reference manifest reserved field is nonzero");
  }

  const nodeCount64 = view.getBigUint64(32, true);
  const vectorCount64 = view.getBigUint64(40, true);
  if (nodeCount64 === 0n || nodeCount64 > BigInt(MAX_U32_DIRECTORY_LENGTH)) {
    throw new RangeError(`fork reference node count ${nodeCount64} is invalid`);
  }
  if (vectorCount64 > BigInt(MAX_U32)) {
    throw new RangeError(`fork reference vector count ${vectorCount64} is invalid`);
  }
  const totals: SectionTotals = {
    nodes: view.getBigUint64(48, true),
    edges: view.getBigUint64(56, true),
    scalars: view.getBigUint64(64, true),
    vectorIndex: view.getBigUint64(72, true),
    vectorEntries: view.getBigUint64(80, true),
  };
  const expectedNodeBytes = multiplyU64(
    nodeCount64,
    BigInt(FORK_REFERENCE_NODE_RECORD_SIZE),
    "fork reference node bytes",
  );
  const expectedVectorIndexBytes = multiplyU64(
    vectorCount64,
    BigInt(FORK_REFERENCE_VECTOR_INDEX_SIZE),
    "fork reference vector-index bytes",
  );
  if (totals.nodes !== expectedNodeBytes) {
    throw new Error(
      `fork reference node section has ${totals.nodes} bytes; `
      + `expected ${expectedNodeBytes}`,
    );
  }
  if (totals.vectorIndex !== expectedVectorIndexBytes) {
    throw new Error(
      `fork reference vector-index section has ${totals.vectorIndex} bytes; `
      + `expected ${expectedVectorIndexBytes}`,
    );
  }
  if (totals.edges % 4n !== 0n || totals.vectorEntries % 4n !== 0n) {
    throw new Error("fork reference u32 section byte length is not divisible by four");
  }
  const expectedTotal = sectionTotalsArray(totals).reduce(
    (sum, value) => addU64(sum, value, "fork reference logical bytes"),
    0n,
  );
  const declaredTotal = view.getBigUint64(88, true);
  if (declaredTotal !== expectedTotal) {
    throw new Error(
      `fork reference manifest declares ${declaredTotal} logical bytes; `
      + `sections contain ${expectedTotal}`,
    );
  }
  return {
    segmentCount: view.getBigUint64(24, true),
    nodeCount: Number(nodeCount64),
    vectorCount: Number(vectorCount64),
    totals,
  };
}

function decodeSegment(
  payload: Uint8Array,
  expectedOrdinal: bigint,
): {
  readonly section: ReferenceSection;
  readonly offset: bigint;
  readonly data: Uint8Array;
} {
  if (payload.byteLength < FORK_REFERENCE_SEGMENT_HEADER_SIZE) {
    throw new Error(`fork reference segment ${expectedOrdinal} header is truncated`);
  }
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  if (view.getUint32(0, true) !== KFRS_MAGIC) {
    throw new Error(`fork reference segment ${expectedOrdinal} has invalid magic`);
  }
  if (view.getUint16(4, true) !== FORK_REFERENCE_TRANSACTION_VERSION) {
    throw new Error(
      `fork reference segment ${expectedOrdinal} has unsupported version`,
    );
  }
  if (view.getUint16(6, true) !== FORK_REFERENCE_SEGMENT_HEADER_SIZE) {
    throw new Error(
      `fork reference segment ${expectedOrdinal} declares an invalid header size`,
    );
  }
  const section = view.getUint16(8, true);
  if (section < ReferenceSection.Nodes || section > ReferenceSection.VectorEntries) {
    throw new Error(
      `fork reference segment ${expectedOrdinal} has unknown section ${section}`,
    );
  }
  if (
    view.getUint16(10, true) !== WPK_FORK_REFERENCE_SEGMENT_KNOWN_FLAGS
    || view.getUint32(12, true) !== 0
    || view.getUint32(36, true) !== 0
  ) {
    throw new Error(
      `fork reference segment ${expectedOrdinal} flags or reserved fields are nonzero`,
    );
  }
  const ordinal = view.getBigUint64(16, true);
  if (ordinal !== expectedOrdinal) {
    throw new Error(
      `fork reference segment ordinal ${ordinal} is not expected ${expectedOrdinal}`,
    );
  }
  const dataLength = view.getUint32(32, true);
  if (
    dataLength === 0
    || payload.byteLength !== FORK_REFERENCE_SEGMENT_HEADER_SIZE + dataLength
  ) {
    throw new Error(
      `fork reference segment ${expectedOrdinal} has invalid data length`,
    );
  }
  return {
    section: section as ReferenceSection,
    offset: view.getBigUint64(24, true),
    data: payload.subarray(FORK_REFERENCE_SEGMENT_HEADER_SIZE),
  };
}

export function validateReferenceSemantics(
  parsed: ParsedSegmentedForkReferenceTransaction,
): ValidatedReferenceSemantics {
  validateNodeSemantics(parsed);
  return validateVectorSemantics(parsed);
}

function validateNodeSemantics(
  parsed: ParsedSegmentedForkReferenceTransaction,
): void {
  const nodeReader = requiredSection(parsed, ReferenceSection.Nodes).reader();
  const edgeReader = requiredSection(parsed, ReferenceSection.Edges).reader();
  const scalarReader = requiredSection(parsed, ReferenceSection.Scalars).reader();
  const recordBytes = new Uint8Array(FORK_REFERENCE_NODE_RECORD_SIZE);
  let expectedEdgeStart = 0n;
  let expectedScalarStart = 0n;

  for (let id = 0; id < parsed.manifest.nodeCount; id++) {
    nodeReader.readInto(recordBytes);
    const header = decodeNodeHeader(recordBytes, id);
    validateNodeHeader(
      header,
      id,
      expectedEdgeStart,
      expectedScalarStart,
    );
    for (let edgeIndex = 0n; edgeIndex < header.edgeCount; edgeIndex++) {
      const recipeId = edgeReader.readU32();
      if (recipeId >= parsed.manifest.nodeCount) {
        throw new Error(
          `fork reference node ${id} edge ${edgeIndex} names `
          + `missing recipe ${recipeId}`,
        );
      }
    }
    scalarReader.skip(header.scalarLength);
    expectedEdgeStart = addU64(
      expectedEdgeStart,
      header.edgeCount,
      "fork reference consumed edge count",
    );
    expectedScalarStart = addU64(
      expectedScalarStart,
      header.scalarLength,
      "fork reference consumed scalar bytes",
    );
  }
  nodeReader.requireEnd("fork reference node records");
  edgeReader.requireEnd("fork reference graph edges");
  scalarReader.requireEnd("fork reference scalar payloads");
}

function validateVectorSemantics(
  parsed: ParsedSegmentedForkReferenceTransaction,
): ValidatedReferenceSemantics {
  const indexReader = requiredSection(
    parsed,
    ReferenceSection.VectorIndex,
  ).reader();
  const entries = requiredSection(parsed, ReferenceSection.VectorEntries);
  const entryReader = entries.reader();
  const indexBytes = new Uint8Array(FORK_REFERENCE_VECTOR_INDEX_SIZE);
  const vectors = new PagedForkReferenceDirectory<ValidatedVectorRange>();
  const vectorIntern: MutableForkReferenceVectorInternIndex = new Map();
  let expectedStart = 0n;

  for (let ordinal = 1; ordinal <= parsed.manifest.vectorCount; ordinal++) {
    indexReader.readInto(indexBytes);
    const view = new DataView(indexBytes.buffer);
    const start = view.getBigUint64(0, true);
    const length64 = view.getBigUint64(8, true);
    if (start !== expectedStart) {
      throw new Error(
        `fork reference vector ${ordinal} starts at ${start}; `
        + `expected ${expectedStart}`,
      );
    }
    if (length64 === 0n || length64 > BigInt(MAX_U32)) {
      throw new RangeError(
        `fork reference vector ${ordinal} length ${length64} is invalid`,
      );
    }
    const length = Number(length64);
    let first = (0x811c_9dc5 ^ length) >>> 0;
    let second = (0x9e37_79b9 ^ length) >>> 0;
    for (let index = 0; index < length; index++) {
      const recipeId = entryReader.readU32();
      if (recipeId >= parsed.manifest.nodeCount) {
        throw new Error(
          `fork reference vector ${ordinal} entry ${index} names `
          + `missing recipe ${recipeId}`,
        );
      }
      first = Math.imul(first ^ recipeId, 0x0100_0193) >>> 0;
      const rotated = ((recipeId << 16) | (recipeId >>> 16)) >>> 0;
      second = Math.imul(second ^ rotated, 0x85eb_ca6b) >>> 0;
      second = (second ^ (first >>> 13)) >>> 0;
    }
    const key = `${length}:${first}:${second}`;
    for (const previousOrdinal of vectorIntern.get(key) ?? []) {
      const previous = requiredDirectoryEntry(
        vectors,
        previousOrdinal - 1,
        "fork reference vector range",
      );
      if (vectorRangesEqual(entries, previous, { start, length })) {
        throw new Error(
          `fork reference vector ${ordinal} duplicates canonical vector `
          + `${previousOrdinal}`,
        );
      }
    }
    let bucket = vectorIntern.get(key);
    if (!bucket) {
      bucket = new PagedForkReferenceDirectory<number>();
      vectorIntern.set(key, bucket);
    }
    bucket.push(ordinal);
    vectors.push(Object.freeze({ start, length }));
    expectedStart = addU64(
      expectedStart,
      length64,
      "fork reference vector entry count",
    );
  }
  indexReader.requireEnd("fork reference vector indexes");
  entryReader.requireEnd("fork reference vector entries");
  return { vectors, vectorIntern };
}

function vectorRangesEqual(
  entries: SegmentedSection,
  left: ValidatedVectorRange,
  right: ValidatedVectorRange,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const local = BigInt(index) * 4n;
    if (
      entries.readU32At(left.start * 4n + local)
      !== entries.readU32At(right.start * 4n + local)
    ) {
      return false;
    }
  }
  return true;
}

export interface DecodedNodeHeader {
  readonly kind: WireNodeKind;
  readonly first: number;
  readonly second: number;
  readonly third: number;
  readonly edgeStart: bigint;
  readonly edgeCount: bigint;
  readonly scalarStart: bigint;
  readonly scalarLength: bigint;
}

export function decodeNodeHeader(
  bytes: Uint8Array,
  id: number,
): DecodedNodeHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(1) !== 0 || view.getUint16(2, true) !== 0) {
    throw new Error(`fork reference node ${id} has nonzero flags or reserved fields`);
  }
  const kind = view.getUint8(0);
  if (kind < WireNodeKind.Null || kind > WireNodeKind.StaticRoot) {
    throw new Error(`fork reference node ${id} has unknown kind ${kind}`);
  }
  return {
    kind: kind as WireNodeKind,
    first: view.getUint32(4, true),
    second: view.getUint32(8, true),
    third: view.getUint32(12, true),
    edgeStart: view.getBigUint64(16, true),
    edgeCount: view.getBigUint64(24, true),
    scalarStart: view.getBigUint64(32, true),
    scalarLength: view.getBigUint64(40, true),
  };
}

function validateNodeHeader(
  header: DecodedNodeHeader,
  id: number,
  expectedEdgeStart: bigint,
  expectedScalarStart: bigint,
): void {
  const context = `fork reference node ${id}`;
  const aggregate =
    header.kind === WireNodeKind.Exnref
    || header.kind === WireNodeKind.Struct
    || header.kind === WireNodeKind.Array;
  if (aggregate) {
    if (
      header.edgeStart !== expectedEdgeStart
      || header.scalarStart !== expectedScalarStart
    ) {
      throw new Error(
        `${context} has noncanonical edge or scalar start`,
      );
    }
    if (
      header.edgeCount > BigInt(MAX_U32)
      || header.scalarLength > BigInt(MAX_U32)
    ) {
      throw new RangeError(`${context} aggregate length exceeds u32`);
    }
  } else if (
    header.edgeStart !== 0n
    || header.edgeCount !== 0n
    || header.scalarStart !== 0n
    || header.scalarLength !== 0n
  ) {
    throw new Error(`${context} scalar record declares aggregate data`);
  }

  switch (header.kind) {
    case WireNodeKind.Null:
      if (
        id !== 0
        || header.first !== 0
        || header.second !== 0
        || header.third !== 0
      ) {
        throw new Error(`${context} is not the canonical null recipe`);
      }
      break;
    case WireNodeKind.Funcref:
    case WireNodeKind.StaticRoot:
      if (header.third !== 0) {
        throw new Error(`${context} reserved scalar field is nonzero`);
      }
      break;
    case WireNodeKind.Externref:
      decodeHandle(header.first, header.second, id);
      if (header.third !== 0) {
        throw new Error(`${context} externref reserved scalar field is nonzero`);
      }
      break;
    case WireNodeKind.I31: {
      if (header.second !== 0 || header.third !== 0) {
        throw new Error(`${context} i31 reserved scalar field is nonzero`);
      }
      const value = header.first | 0;
      if (value < -0x4000_0000 || value > 0x3fff_ffff) {
        throw new RangeError(`${context} has invalid i31 payload ${value}`);
      }
      break;
    }
    case WireNodeKind.Exnref:
    case WireNodeKind.Struct:
    case WireNodeKind.Array:
      break;
  }
}

export function decodeHandle(first: number, second: number, id: number): number {
  const handle = Number((BigInt(second) << 32n) | BigInt(first));
  if (
    !Number.isInteger(handle)
    || handle <= 0
    || handle > MAX_U32
  ) {
    throw new RangeError(
      `fork reference node ${id} externref handle ${handle} is invalid`,
    );
  }
  return handle;
}

export function requiredSection(
  parsed: ParsedSegmentedForkReferenceTransaction,
  section: ReferenceSection,
): SegmentedSection {
  const value = parsed.sections.get(section);
  if (!value) {
    throw new Error(`fork reference section ${section} is absent`);
  }
  return value;
}

export function requiredDirectoryEntry<T>(
  directory: ForkReferenceSequence<T>,
  index: number,
  context: string,
): T {
  const present = Array.isArray(directory)
    ? index >= 0 && index < directory.length && index in directory
    : (directory as ForkReferenceDirectory<T>).has(index);
  if (!present) {
    throw new Error(`${context} ${index} is absent`);
  }
  return (
    Array.isArray(directory)
      ? directory[index]
      : (directory as ForkReferenceDirectory<T>).get(index)
  )!;
}

export function sectionTotalsArray(totals: SectionTotals): readonly bigint[] {
  return [
    totals.nodes,
    totals.edges,
    totals.scalars,
    totals.vectorIndex,
    totals.vectorEntries,
  ];
}

export function addU64(left: bigint, right: bigint, context: string): bigint {
  if (left < 0n || right < 0n || left > MAX_U64 - right) {
    throw new RangeError(`${context} exceeds u64`);
  }
  return left + right;
}

export function multiplyU64(left: bigint, right: bigint, context: string): bigint {
  if (left < 0n || right < 0n || (right !== 0n && left > MAX_U64 / right)) {
    throw new RangeError(`${context} exceeds u64`);
  }
  return left * right;
}

export function assertU32(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_U32) {
    throw new RangeError(`${context} is not an unsigned 32-bit integer`);
  }
}

export function assertOwner(ownerId: number): void {
  assertU32(ownerId, "fork reference owner id");
  if (ownerId === 0) {
    throw new RangeError("fork reference owner id must be nonzero");
  }
}

function littleEndianMagic(bytes: readonly number[]): number {
  if (bytes.length !== 4) {
    throw new Error("fork reference ABI magic must contain four bytes");
  }
  return (
    bytes[0]!
    | (bytes[1]! << 8)
    | (bytes[2]! << 16)
    | (bytes[3]! << 24)
  ) >>> 0;
}
