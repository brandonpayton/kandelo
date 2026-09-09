import { WASM_PAGE_SIZE } from "./constants";
import {
  ContinuationAllocationError,
  type ContinuationAllocate,
  type ContinuationDeallocate,
} from "./fork-continuation";
import {
  type ForkReplayEventCaptureSource,
  type ForkReplayEventWire,
  validateForkReplayEventWire,
} from "./fork-replay-events";
/*
 * Keep the allocation error as a runtime import: fork() must return its errno
 * after an arena mmap failure, not turn an ordinary resource failure into a
 * process trap.
 */
import {
  WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_KNOWN_FLAGS,
  WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE,
  WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE,
  WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS,
  WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC,
  WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER,
  WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION,
  WPK_FORK_JOURNAL_IMAGE_HEADER_SIZE,
  WPK_FORK_JOURNAL_IMAGE_KNOWN_FLAGS,
  WPK_FORK_JOURNAL_IMAGE_MAGIC,
  WPK_FORK_JOURNAL_IMAGE_OWNER,
  WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE,
  WPK_FORK_JOURNAL_IMAGE_VERSION,
  WPK_FORK_MODULE_STATE_ARENA_VERSION,
  WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT,
  WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED,
  WPK_FORK_MODULE_STATE_CHUNK_MAGIC,
  WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS,
  WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER,
  WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES,
  WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
  WPK_FORK_MODULE_STATE_FORMAT_SECTION,
  WPK_FORK_MODULE_STATE_FORMAT_VERSION,
  WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
  WPK_FORK_MODULE_STATE_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT,
  WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT,
  WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE,
  WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE,
  WPK_FORK_MODULE_STATE_POINTER_WIDTHS,
  WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT,
  WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
  WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS,
  WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
  WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
  WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS,
  WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
  WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
  WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE,
  WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT,
  WPK_FORK_MODULE_STATE_RECORD_KIND_JOURNAL_IMAGE,
  WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS,
  WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT,
  WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
  WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
  WPK_FORK_MODULE_STATE_RECORD_MAGIC,
  WPK_FORK_MODULE_STATE_RECORD_VERSION,
  WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
  WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE,
  WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE,
  WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES,
  WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS,
  WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE,
  WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER,
  WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE,
  WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED,
  WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_KNOWN_FLAGS,
  WPK_FORK_IMPORTED_GLOBALS_MAGIC,
  WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_SECTION,
  WPK_FORK_IMPORTED_GLOBALS_VERSION,
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE,
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS,
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC,
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER,
  WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
  WPK_FORK_IMPORTED_TABLES_FLAG_TABLE64,
  WPK_FORK_IMPORTED_TABLES_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_KNOWN_FLAGS,
  WPK_FORK_IMPORTED_TABLES_MAGIC,
  WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_SECTION,
  WPK_FORK_IMPORTED_TABLES_VERSION,
  WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE,
  WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS,
  WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC,
  WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER,
  WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION,
  WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
  WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT,
} from "./generated/abi";

/**
 * Versioned artifact metadata for activation-owned module-state recipes.
 *
 * Keep the short aliases as the arena's public API, but source every wire
 * literal from the generated shared ABI contract.
 */
export const FORK_MODULE_STATE_SECTION = WPK_FORK_MODULE_STATE_FORMAT_SECTION;
export const FORK_MODULE_STATE_DESCRIPTOR_MAGIC = WPK_FORK_MODULE_STATE_FORMAT_MAGIC;
export const FORK_MODULE_STATE_DESCRIPTOR_VERSION = WPK_FORK_MODULE_STATE_FORMAT_VERSION;
export const FORK_MODULE_STATE_DESCRIPTOR_SIZE = WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE;
export const FORK_MODULE_STATE_RECORD_ALIGNMENT = WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT;
export const FORK_MODULE_STATE_ARENA_VERSION = WPK_FORK_MODULE_STATE_ARENA_VERSION;
export const FORK_MODULE_STATE_RECORD_VERSION = WPK_FORK_MODULE_STATE_RECORD_VERSION;
export const FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET =
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET;

export const FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER =
  WPK_FORK_MODULE_STATE_FLAG_ROOT_PREFIX_POINTER;
export const FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS =
  WPK_FORK_MODULE_STATE_FLAG_EXPLICIT_OWNERS;
export const FORK_MODULE_STATE_FLAG_SPARSE_TABLES =
  WPK_FORK_MODULE_STATE_FLAG_SPARSE_TABLES;
export const FORK_MODULE_STATE_REQUIRED_FLAGS = WPK_FORK_MODULE_STATE_REQUIRED_FLAGS;
export const FORK_MODULE_STATE_KNOWN_FLAGS = WPK_FORK_MODULE_STATE_KNOWN_FLAGS;

const CHUNK_MAGIC = littleEndianMagic(WPK_FORK_MODULE_STATE_CHUNK_MAGIC);
const RECORD_MAGIC = littleEndianMagic(WPK_FORK_MODULE_STATE_RECORD_MAGIC);
const CHUNK_FLAG_ROOT = WPK_FORK_MODULE_STATE_CHUNK_FLAG_ROOT;
const CHUNK_FLAG_SEALED = WPK_FORK_MODULE_STATE_CHUNK_FLAG_SEALED;
const RECORD_HEADER_SIZE = WPK_FORK_MODULE_STATE_RECORD_HEADER_SIZE;
export const FORK_MODULE_STATE_TEMPLATE_ID_SIZE =
  WPK_FORK_MODULE_STATE_MODULE_TEMPLATE_ID_SIZE;
export const FORK_MODULE_STATE_BASELINE_FINGERPRINT_SIZE =
  WPK_FORK_MODULE_STATE_TABLE_BASELINE_FINGERPRINT_SIZE;
const MODULE_TEMPLATE_ID_SIZE = FORK_MODULE_STATE_TEMPLATE_ID_SIZE;
const MODULE_RECORD_PAYLOAD_SIZE = WPK_FORK_MODULE_STATE_MODULE_RECORD_PAYLOAD_SIZE;
const MODULE_RECORD_KNOWN_FLAGS = WPK_FORK_MODULE_STATE_MODULE_RECORD_KNOWN_FLAGS;
const TABLE_DESCRIPTOR_PAYLOAD_SIZE = WPK_FORK_MODULE_STATE_TABLE_DESCRIPTOR_PAYLOAD_SIZE;
const TABLE_FLAG_SPARSE_OVERRIDES = WPK_FORK_MODULE_STATE_TABLE_FLAG_SPARSE_OVERRIDES;
const TABLE_KNOWN_FLAGS = WPK_FORK_MODULE_STATE_TABLE_KNOWN_FLAGS;
const TABLE_PAGE_HEADER_SIZE = WPK_FORK_MODULE_STATE_TABLE_PAGE_HEADER_SIZE;
const TABLE_RUN_HEADER_SIZE = WPK_FORK_MODULE_STATE_TABLE_RUN_HEADER_SIZE;
const ELEMENT_SEGMENT_HEADER_SIZE = WPK_FORK_MODULE_STATE_ELEMENT_SEGMENT_HEADER_SIZE;
const DATA_SEGMENT_HEADER_SIZE = WPK_FORK_MODULE_STATE_DATA_SEGMENT_HEADER_SIZE;
const GLOBAL_HEADER_SIZE = WPK_FORK_MODULE_STATE_GLOBAL_HEADER_SIZE;
const MIN_TABLE_PAGE_SHIFT = WPK_FORK_MODULE_STATE_MIN_TABLE_PAGE_SHIFT;
const MAX_TABLE_PAGE_SHIFT = WPK_FORK_MODULE_STATE_MAX_TABLE_PAGE_SHIFT;

export interface ForkModuleStateDescriptor {
  version: number;
  ptrWidth: 4 | 8;
  alignment: number;
  flags: number;
  arenaVersion: number;
  recordVersion: number;
  rootPointerWordOffset: number;
}

export const ForkModuleStateRecordKind = {
  Module: WPK_FORK_MODULE_STATE_RECORD_KIND_MODULE,
  ReferenceRecipe: WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE,
  MutableGlobal: WPK_FORK_MODULE_STATE_RECORD_KIND_MUTABLE_GLOBAL,
  Table: WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE,
  TablePage: WPK_FORK_MODULE_STATE_RECORD_KIND_TABLE_PAGE,
  ElementSegments: WPK_FORK_MODULE_STATE_RECORD_KIND_ELEMENT_SEGMENTS,
  DataSegments: WPK_FORK_MODULE_STATE_RECORD_KIND_DATA_SEGMENTS,
  ReplayEvents: WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENTS,
  ImportedGlobalBindings: WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
  ActivationContinuations: WPK_FORK_MODULE_STATE_RECORD_KIND_ACTIVATION_CONTINUATIONS,
  ImportedTableBindings: WPK_FORK_MODULE_STATE_RECORD_KIND_IMPORTED_TABLE_BINDINGS,
  ReferenceRecipeSegment:
    WPK_FORK_MODULE_STATE_RECORD_KIND_REFERENCE_RECIPE_SEGMENT,
  ReplayEventSegment: WPK_FORK_MODULE_STATE_RECORD_KIND_REPLAY_EVENT_SEGMENT,
  JournalImage: WPK_FORK_MODULE_STATE_RECORD_KIND_JOURNAL_IMAGE,
} as const;

export type ForkModuleStateRecordKind =
  typeof ForkModuleStateRecordKind[keyof typeof ForkModuleStateRecordKind];

const RECORD_KINDS = new Set<number>(Object.values(ForkModuleStateRecordKind));

export interface ForkModuleStateRecord {
  kind: ForkModuleStateRecordKind;
  activationId: number;
  ownerId: number;
  payload: Uint8Array;
}

/**
 * A validated record envelope whose payload may alias the sealed arena.
 *
 * The view is valid only while its owning process memory and arena mapping are
 * alive. Consumers that need a longer lifetime must copy the specific bytes
 * they retain; streaming decoders should keep the view to avoid duplicating a
 * whole segmented transaction.
 */
export interface ForkModuleStateRecordView {
  readonly kind: ForkModuleStateRecordKind;
  readonly activationId: number;
  readonly ownerId: number;
  readonly payload: Uint8Array;
}

export interface ForkImportedGlobalState {
  module: string;
  name: string;
  importOrdinal: number;
  ownerId: number;
  typeCode: number;
  mutable: boolean;
  shared: boolean;
}

export interface ForkImportedTableState {
  module: string;
  name: string;
  importOrdinal: number;
  ownerId: number;
  typeCode: number;
  table64: boolean;
}

export const ForkImportedGlobalBindingKind = {
  RawNumber: WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
  RawBigInt: WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
  RawReference: WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
  ActivationGlobal: WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
  BaseImport: WPK_FORK_IMPORTED_GLOBAL_BINDING_BASE_IMPORT,
} as const;

export type ForkImportedGlobalBindingKind =
  typeof ForkImportedGlobalBindingKind[keyof typeof ForkImportedGlobalBindingKind];

export interface ForkImportedGlobalBinding {
  consumerActivation: number;
  consumerOwner: number;
  sourceActivation: number;
  sourceOwner: number;
  reserved: number;
  recipeId: number;
  rawBits: bigint;
  kind: ForkImportedGlobalBindingKind;
  mutable: boolean;
  shared: boolean;
  typeCode: number;
}

export const ForkImportedTableBindingKind = {
  ActivationTable: WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
  BaseImport: WPK_FORK_IMPORTED_TABLE_BINDING_BASE_IMPORT,
} as const;

export type ForkImportedTableBindingKind =
  typeof ForkImportedTableBindingKind[keyof typeof ForkImportedTableBindingKind];

export interface ForkImportedTableBinding {
  consumerActivation: number;
  consumerOwner: number;
  sourceActivation: number;
  sourceOwner: number;
  reserved: number;
  kind: ForkImportedTableBindingKind;
}

export interface ForkGlobalSnapshot {
  typeCode: number;
  value: Uint8Array;
  recipeId?: number;
}

export interface ForkActivationContinuation {
  activationId: number;
  root: bigint;
}

/**
 * A `JournalImage` KFMS record (Option B): the guest offset the parent
 * channel-mmap'd the serialized KFRE replay-event journal image to, plus its
 * byte length. The child reads this from the inherited arena to find and decode
 * the image (it no longer sits at a host-computed arena offset). Fixed-width
 * u64 fields so one record names wasm32 and wasm64 forks alike.
 */
export interface ForkJournalImage {
  ptr: bigint;
  len: bigint;
}

export interface ForkModuleDescriptorRecord {
  activationId: number;
  templateId: Uint8Array;
  flags?: number;
}

export interface ForkSparseTableRun {
  start: number;
  recipeIds: readonly number[] | Uint32Array;
}

export interface ForkSparseTablePage {
  pageIndex: number | bigint;
  runs: readonly ForkSparseTableRun[];
}

export interface ForkSparseTableSnapshot {
  activationId: number;
  ownerId: number;
  indexWidth: 4 | 8;
  pageShift: number;
  length: number | bigint;
  baselineLength: number | bigint;
  baselineFingerprint: Uint8Array;
  pages: readonly ForkSparseTablePage[];
}

export interface DecodedForkSparseTableRun {
  start: number;
  recipeIds: Uint32Array;
}

export interface DecodedForkSparseTablePage {
  pageIndex: bigint;
  runs: DecodedForkSparseTableRun[];
}

export interface DecodedForkSparseTableSnapshot {
  activationId: number;
  ownerId: number;
  indexWidth: 4 | 8;
  pageShift: number;
  length: bigint;
  baselineLength: bigint;
  baselineFingerprint: Uint8Array;
  pages: DecodedForkSparseTablePage[];
}

interface DirtyPageJournal {
  intervals: Array<{ start: bigint; end: bigint }>;
  cumulativeEnds: bigint[];
  count: bigint;
}

interface DirtyPageJournalNode {
  parent: DirtyPageJournalNode;
  journal: DirtyPageJournal;
  stateOwner: boolean;
}

/**
 * Process-lifetime journal of table pages changed from the deterministic
 * instantiation baseline.
 *
 * Generated Wasm calls `markPages` after successful table mutations. The
 * journal stores merged intervals rather than one object per page, while
 * `pageAt` exposes a deterministic sorted enumeration to the KFMS save helper.
 * It intentionally outlives one fork transaction: a replayed child seeds the
 * same journal while applying overlays so a later child does not mistake the
 * restored parent state for its static baseline.
 */
export class ForkTableDirtyTracker {
  private readonly journals = new Map<number, DirtyPageJournalNode>();

  /**
   * Make two activation-local owner ordinals describe one physical Table.
   *
   * Imported table aliases are discovered only after instantiation. Unioning
   * journals (including journals that already contain start-function writes)
   * ensures a mutation through any alias reaches one canonical KFMS sparse
   * snapshot. Every activation still replays its static element baseline.
   * State ownership is elected separately because the union root may belong
   * to a provider activation that was later unloaded while an imported alias
   * remains live.
   */
  aliasOwner(
    ownerId: number,
    source: ForkTableDirtyTracker,
    sourceOwnerId: number,
  ): void {
    checkedU32(ownerId, "table dirty owner", false);
    checkedU32(sourceOwnerId, "table dirty source owner", false);
    const targetNode = this.node(ownerId);
    const sourceNode = source.node(sourceOwnerId);
    targetNode.stateOwner = false;
    sourceNode.stateOwner = true;
    const targetRoot = this.root(targetNode);
    const sourceRoot = source.root(sourceNode);
    if (targetRoot === sourceRoot) return;
    mergeDirtyPageJournals(sourceRoot.journal, targetRoot.journal);
    targetRoot.parent = sourceRoot;
  }

  /** Whether this activation-local coordinate owns the physical table state. */
  ownsState(ownerId: number): boolean {
    checkedU32(ownerId, "table state owner", false);
    return this.node(ownerId).stateOwner;
  }

  /**
   * Elect or retire this live activation coordinate as sparse-state owner.
   *
   * The journal's union topology deliberately remains intact so mutations
   * accumulated through a now-unloaded provider are not lost when ownership
   * moves to a surviving alias.
   */
  setStateOwner(ownerId: number, owned: boolean): void {
    checkedU32(ownerId, "table state owner", false);
    this.node(ownerId).stateOwner = owned;
  }

  markPages(
    ownerId: number,
    firstPageValue: number | bigint,
    pageCountValue: number | bigint,
  ): void {
    checkedU32(ownerId, "table dirty owner", false);
    const firstPage = checkedWasmU64(firstPageValue, "table dirty first page");
    const pageCount = checkedWasmU64(pageCountValue, "table dirty page count");
    if (pageCount === 0n) return;
    const end = firstPage + pageCount;
    if (end > (1n << 64n)) {
      throw new RangeError("table dirty page range exceeds u64");
    }
    const journal = this.root(this.node(ownerId)).journal;
    let insertion = 0;
    while (
      insertion < journal.intervals.length
      && journal.intervals[insertion]!.end < firstPage
    ) {
      insertion++;
    }
    let mergedStart = firstPage;
    let mergedEnd = end;
    let removalEnd = insertion;
    while (
      removalEnd < journal.intervals.length
      && journal.intervals[removalEnd]!.start <= mergedEnd
    ) {
      const interval = journal.intervals[removalEnd]!;
      if (interval.start < mergedStart) mergedStart = interval.start;
      if (interval.end > mergedEnd) mergedEnd = interval.end;
      removalEnd++;
    }
    journal.intervals.splice(
      insertion,
      removalEnd - insertion,
      { start: mergedStart, end: mergedEnd },
    );
    rebuildDirtyPageJournal(journal);
  }

  pageCount(ownerId: number): number {
    checkedU32(ownerId, "table dirty owner", false);
    const node = this.journals.get(ownerId);
    const count = node ? this.root(node).journal.count : 0n;
    if (count > 0xffff_ffffn) {
      throw new RangeError("table dirty page count exceeds KFMS u32 record count");
    }
    return Number(count);
  }

  pageAt(ownerId: number, ordinal: number): bigint {
    checkedU32(ownerId, "table dirty owner", false);
    checkedU32(ordinal, "table dirty page ordinal");
    const node = this.journals.get(ownerId);
    const journal = node ? this.root(node).journal : undefined;
    if (!journal || BigInt(ordinal) >= journal.count) {
      throw new RangeError(
        `table dirty owner ${ownerId} has no page ordinal ${ordinal}`,
      );
    }
    const target = BigInt(ordinal);
    let low = 0;
    let high = journal.cumulativeEnds.length;
    while (low < high) {
      const mid = low + ((high - low) >> 1);
      if (target < journal.cumulativeEnds[mid]!) high = mid;
      else low = mid + 1;
    }
    const previous = low === 0 ? 0n : journal.cumulativeEnds[low - 1]!;
    const page = journal.intervals[low]!.start + (target - previous);
    // WebAssembly i64 crosses JavaScript as signed BigInt. Preserve the exact
    // unsigned page bits for the generated helper's i64 shifts/stores.
    return BigInt.asIntN(64, page);
  }

  private node(ownerId: number): DirtyPageJournalNode {
    const existing = this.journals.get(ownerId);
    if (existing) return existing;
    const journal: DirtyPageJournal = {
      intervals: [],
      cumulativeEnds: [],
      count: 0n,
    };
    const node = {} as DirtyPageJournalNode;
    node.parent = node;
    node.journal = journal;
    node.stateOwner = true;
    this.journals.set(ownerId, node);
    return node;
  }

  private root(node: DirtyPageJournalNode): DirtyPageJournalNode {
    let root = node;
    while (root.parent !== root) root = root.parent;
    let cursor = node;
    while (cursor.parent !== cursor) {
      const parent = cursor.parent;
      cursor.parent = root;
      cursor = parent;
    }
    return root;
  }
}

function checkedWasmU64(value: number | bigint, context: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${context}: expected an exact non-negative integer`);
  }
  const signed = typeof value === "bigint" ? value : BigInt(value);
  const exact = BigInt.asUintN(64, signed);
  if (signed >= 0n && signed !== exact) {
    throw new RangeError(`${context}: value exceeds u64`);
  }
  return exact;
}

function rebuildDirtyPageJournal(journal: DirtyPageJournal): void {
  let count = 0n;
  journal.cumulativeEnds = journal.intervals.map((interval) => {
    count += interval.end - interval.start;
    return count;
  });
  journal.count = count;
}

function mergeDirtyPageJournals(
  target: DirtyPageJournal,
  source: DirtyPageJournal,
): void {
  if (source.intervals.length === 0) return;
  const intervals = [...target.intervals, ...source.intervals]
    .sort((left, right) =>
      left.start < right.start ? -1 : left.start > right.start ? 1 : 0
    );
  target.intervals = [];
  for (const interval of intervals) {
    const previous = target.intervals[target.intervals.length - 1];
    if (!previous || previous.end < interval.start) {
      target.intervals.push({ ...interval });
    } else if (interval.end > previous.end) {
      previous.end = interval.end;
    }
  }
  rebuildDirtyPageJournal(target);
}

export interface ForkElementSegmentState {
  activationId: number;
  ownerId: number;
  segmentCount: number;
  dropped: Uint8Array;
}

export interface ForkDataSegmentState {
  activationId: number;
  ownerId: number;
  segmentCount: number;
  dropped: Uint8Array;
}

export async function computeForkModuleTemplateId(
  bytes: ArrayBuffer | ArrayBufferView,
): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("SHA-256 is unavailable for fork module template identity");
  }
  const source = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // WebCrypto excludes SharedArrayBuffer-backed views. A module template is
  // immutable input, so one exact owned copy also avoids hashing a concurrently
  // changing shared view.
  const owned = new Uint8Array(source);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", owned));
}

const SHA256_INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight32(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/**
 * Synchronous, host-neutral SHA-256 for the synchronous `dlopen` import.
 *
 * The implementation streams one 64-byte block at a time, so exact module
 * identity does not require a second module-sized padding allocation. Keep
 * the WebCrypto implementation above for async main-program admission; tests
 * require both paths to produce byte-identical digests.
 */
export function computeForkModuleTemplateIdSync(
  bytes: ArrayBuffer | ArrayBufferView,
): Uint8Array {
  const source = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const totalLength = Math.ceil((source.byteLength + 9) / 64) * 64;
  if (!Number.isSafeInteger(totalLength)) {
    throw new RangeError("fork module template is too large to hash safely");
  }

  const state = new Uint32Array(SHA256_INITIAL_STATE);
  const schedule = new Uint32Array(64);
  const block = new Uint8Array(64);
  const blockView = new DataView(block.buffer);
  const bitLength = BigInt(source.byteLength) * 8n;

  for (let offset = 0; offset < totalLength; offset += 64) {
    block.fill(0);
    const sourceEnd = Math.min(offset + 64, source.byteLength);
    if (offset < sourceEnd) {
      block.set(source.subarray(offset, sourceEnd));
    }
    if (source.byteLength >= offset && source.byteLength < offset + 64) {
      block[source.byteLength - offset] = 0x80;
    }
    if (offset + 64 === totalLength) {
      blockView.setBigUint64(56, bitLength, false);
    }

    for (let word = 0; word < 16; word++) {
      schedule[word] = blockView.getUint32(word * 4, false);
    }
    for (let word = 16; word < 64; word++) {
      const x = schedule[word - 15]!;
      const y = schedule[word - 2]!;
      const sigma0 = rotateRight32(x, 7) ^ rotateRight32(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight32(y, 17) ^ rotateRight32(y, 19) ^ (y >>> 10);
      schedule[word] = (
        schedule[word - 16]!
        + sigma0
        + schedule[word - 7]!
        + sigma1
      ) >>> 0;
    }

    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let round = 0; round < 64; round++) {
      const upper = rotateRight32(e, 6)
        ^ rotateRight32(e, 11)
        ^ rotateRight32(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (
        h
        + upper
        + choose
        + SHA256_ROUND_CONSTANTS[round]!
        + schedule[round]!
      ) >>> 0;
      const lower = rotateRight32(a, 2)
        ^ rotateRight32(a, 13)
        ^ rotateRight32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (lower + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let word = 0; word < state.length; word++) {
    digestView.setUint32(word * 4, state[word]!, false);
  }
  return digest;
}

export function requireForkModuleTemplate(
  records: readonly ForkModuleStateRecord[],
  activationId: number,
  expectedTemplateId: Uint8Array,
): void {
  checkedU32(activationId, "module activation id");
  if (expectedTemplateId.byteLength !== MODULE_TEMPLATE_ID_SIZE) {
    throw new RangeError(
      `module template id has ${expectedTemplateId.byteLength} bytes, `
      + `expected ${MODULE_TEMPLATE_ID_SIZE}`,
    );
  }
  const record = records.find(
    (candidate) =>
      candidate.kind === ForkModuleStateRecordKind.Module
      && candidate.activationId === activationId,
  );
  if (!record) {
    throw new Error(`module-state arena is missing activation ${activationId}`);
  }
  if (
    !bytesEqual(
      record.payload.subarray(0, MODULE_TEMPLATE_ID_SIZE),
      expectedTemplateId,
    )
  ) {
    throw new Error(`module-state activation ${activationId} has the wrong template`);
  }
}

interface ArenaChunk {
  addr: number;
  size: number;
  used: number;
  recordCount: number;
}

interface PendingRecord {
  chunk: ArenaChunk;
  kind: ForkModuleStateRecordKind;
  activationId: number;
  ownerId: number;
  payloadAddr: number;
  totalSize: number;
  payloadSize: number;
}

interface DecodedTableDescriptor {
  activationId: number;
  ownerId: number;
  indexWidth: 4 | 8;
  pageShift: number;
  flags: number;
  pageCount: number;
  length: bigint;
  baselineLength: bigint;
  baselineFingerprint: Uint8Array;
}

interface DecodedTablePage {
  activationId: number;
  ownerId: number;
  pageIndex: bigint;
  runs: DecodedForkSparseTableRun[];
  entryCount: number;
}

interface ValidatedTablePage {
  pageIndex: bigint;
  runCount: number;
  entryCount: number;
}

interface ValidatedSparseTablePage {
  pageIndex: bigint;
  entryCount: number;
  payloadSize: number;
}

function littleEndianMagic(bytes: readonly number[]): number {
  return (
    bytes[0]!
    | (bytes[1]! << 8)
    | (bytes[2]! << 16)
    | (bytes[3]! << 24)
  ) >>> 0;
}

function alignUp(value: number, alignment: number): number {
  const result = Math.ceil(value / alignment) * alignment;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`module-state alignment overflow: ${value}`);
  }
  return result;
}

function checkedEnd(addr: number, size: number, context: string): number {
  const end = addr + size;
  if (
    !Number.isSafeInteger(addr)
    || !Number.isSafeInteger(size)
    || addr < 0
    || size < 0
    || !Number.isSafeInteger(end)
  ) {
    throw new RangeError(`${context}: invalid range addr=${addr} size=${size}`);
  }
  return end;
}

function checkedMemoryRange(
  memory: WebAssembly.Memory,
  addr: number,
  size: number,
  context: string,
): void {
  if (checkedEnd(addr, size, context) > memory.buffer.byteLength) {
    throw new RangeError(`${context}: range exceeds WebAssembly memory`);
  }
}

function checkedU32(value: number, context: string, allowZero = true): number {
  if (
    !Number.isInteger(value)
    || value < (allowZero ? 0 : 1)
    || value > 0xffff_ffff
  ) {
    throw new RangeError(`${context}: expected ${allowZero ? "a" : "a nonzero"} u32`);
  }
  return value;
}

function checkedU64(value: number | bigint, context: string): bigint {
  if (
    typeof value === "number"
    && (!Number.isSafeInteger(value) || value < 0)
  ) {
    throw new RangeError(`${context}: expected a u64`);
  }
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result < 0n || result > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`${context}: expected a u64`);
  }
  return result;
}

function checkedPointer(
  value: number | bigint,
  ptrWidth: 4 | 8,
  context: string,
  allowZero: boolean,
): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (
    (typeof value === "bigint" && BigInt(result) !== value)
    || !Number.isSafeInteger(result)
    || result < (allowZero ? 0 : 1)
    || (ptrWidth === 4 && result > 0xffff_ffff)
  ) {
    throw new RangeError(`${context}: invalid ${ptrWidth * 8}-bit guest pointer`);
  }
  return result;
}

function writePointer(
  memory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
  addr: number,
  value: number,
): void {
  checkedMemoryRange(memory, addr, ptrWidth, "module-state pointer write");
  const checked = checkedPointer(value, ptrWidth, "module-state pointer write", true);
  const view = new DataView(memory.buffer);
  if (ptrWidth === 8) view.setBigUint64(addr, BigInt(checked), true);
  else view.setUint32(addr, checked, true);
}

function readPointer(
  memory: WebAssembly.Memory,
  ptrWidth: 4 | 8,
  addr: number,
  context: string,
): number {
  checkedMemoryRange(memory, addr, ptrWidth, context);
  const view = new DataView(memory.buffer);
  const raw = ptrWidth === 8
    ? view.getBigUint64(addr, true)
    : BigInt(view.getUint32(addr, true));
  return checkedPointer(raw, ptrWidth, context, true);
}

function bytesEqual(actual: Uint8Array, expected: ArrayLike<number>): boolean {
  if (actual.byteLength < expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function requireZeroBytes(bytes: Uint8Array, context: string): void {
  if (bytes.some((value) => value !== 0)) {
    throw new Error(`${context}: reserved or padding bytes must be zero`);
  }
}

function chunkHeaderSize(ptrWidth: 4 | 8): number {
  const format = WPK_FORK_MODULE_STATE_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === ptrWidth,
  );
  if (!format) {
    throw new Error(`unsupported module-state pointer width ${ptrWidth}`);
  }
  return format.chunkHeaderSize;
}

function chunkOffset(ptrWidth: 4 | 8, field: 0 | 1 | 2 | 3 | 4): number {
  return 8 + field * ptrWidth;
}

function chunkRecordCountOffset(ptrWidth: 4 | 8): number {
  return 8 + 5 * ptrWidth;
}

function chunkReservedOffset(ptrWidth: 4 | 8): number {
  return 12 + 5 * ptrWidth;
}

function tableKey(activationId: number, ownerId: number): string {
  return `${activationId}:${ownerId}`;
}

function ownerKey(
  kind: ForkModuleStateRecordKind,
  activationId: number,
  ownerId: number,
): string {
  return `${kind}:${activationId}:${ownerId}`;
}

/**
 * Encode the artifact descriptor that binds an instrumented module to this
 * exact arena/record/root-prefix contract.
 */
export function encodeForkModuleStateDescriptor(
  ptrWidth: 4 | 8,
): Uint8Array {
  const bytes = new Uint8Array(FORK_MODULE_STATE_DESCRIPTOR_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(FORK_MODULE_STATE_DESCRIPTOR_MAGIC, 0);
  view.setUint16(4, FORK_MODULE_STATE_DESCRIPTOR_VERSION, true);
  view.setUint16(6, FORK_MODULE_STATE_DESCRIPTOR_SIZE, true);
  view.setUint8(8, ptrWidth);
  view.setUint8(9, FORK_MODULE_STATE_RECORD_ALIGNMENT);
  view.setUint16(10, FORK_MODULE_STATE_REQUIRED_FLAGS, true);
  view.setUint16(12, FORK_MODULE_STATE_ARENA_VERSION, true);
  view.setUint16(14, FORK_MODULE_STATE_RECORD_VERSION, true);
  view.setUint32(16, FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET, true);
  view.setUint32(20, 0, true);
  return bytes;
}

export function decodeForkModuleStateDescriptor(
  bytes: Uint8Array,
): ForkModuleStateDescriptor {
  if (bytes.byteLength !== FORK_MODULE_STATE_DESCRIPTOR_SIZE) {
    throw new Error(
      `module-state descriptor has ${bytes.byteLength} bytes, `
      + `expected ${FORK_MODULE_STATE_DESCRIPTOR_SIZE}`,
    );
  }
  if (!bytesEqual(bytes, FORK_MODULE_STATE_DESCRIPTOR_MAGIC)) {
    throw new Error("module-state descriptor has invalid magic");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FORK_MODULE_STATE_DESCRIPTOR_VERSION) {
    throw new Error(`unsupported module-state descriptor version ${version}`);
  }
  if (view.getUint16(6, true) !== FORK_MODULE_STATE_DESCRIPTOR_SIZE) {
    throw new Error("module-state descriptor declares an invalid size");
  }
  const ptrWidth = view.getUint8(8);
  if (ptrWidth !== 4 && ptrWidth !== 8) {
    throw new Error(`unsupported module-state pointer width ${ptrWidth}`);
  }
  const alignment = view.getUint8(9);
  if (alignment !== FORK_MODULE_STATE_RECORD_ALIGNMENT) {
    throw new Error(`unsupported module-state record alignment ${alignment}`);
  }
  const flags = view.getUint16(10, true);
  if ((flags & ~FORK_MODULE_STATE_KNOWN_FLAGS) !== 0) {
    throw new Error(`unknown module-state descriptor flags 0x${flags.toString(16)}`);
  }
  if ((flags & FORK_MODULE_STATE_REQUIRED_FLAGS) !== FORK_MODULE_STATE_REQUIRED_FLAGS) {
    throw new Error("module-state descriptor omits required ownership features");
  }
  const arenaVersion = view.getUint16(12, true);
  if (arenaVersion !== FORK_MODULE_STATE_ARENA_VERSION) {
    throw new Error(`unsupported module-state arena version ${arenaVersion}`);
  }
  const recordVersion = view.getUint16(14, true);
  if (recordVersion !== FORK_MODULE_STATE_RECORD_VERSION) {
    throw new Error(`unsupported module-state record version ${recordVersion}`);
  }
  const rootPointerWordOffset = view.getUint32(16, true);
  if (rootPointerWordOffset !== FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET) {
    throw new Error(
      `unsupported module-state root-pointer word offset ${rootPointerWordOffset}`,
    );
  }
  if (view.getUint32(20, true) !== 0) {
    throw new Error("module-state descriptor reserved field is nonzero");
  }
  return {
    version,
    ptrWidth,
    alignment,
    flags,
    arenaVersion,
    recordVersion,
    rootPointerWordOffset,
  };
}

export function readForkModuleStateDescriptor(
  module: WebAssembly.Module,
): ForkModuleStateDescriptor {
  const sections = WebAssembly.Module.customSections(module, FORK_MODULE_STATE_SECTION);
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${FORK_MODULE_STATE_SECTION} section, found ${sections.length}`,
    );
  }
  return decodeForkModuleStateDescriptor(new Uint8Array(sections[0]!));
}

const IMPORTED_GLOBAL_TYPE_CODES = new Set<number>([
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
]);

/**
 * Read the pre-instantiation ownership recipe for imported globals.
 *
 * Immutable imports must be supplied with their saved parent value before
 * WebAssembly instantiation: exported imported Globals and const initializers
 * observe that exact binding and cannot be repaired by a later `global.set`.
 */
export function readForkImportedGlobals(
  module: WebAssembly.Module,
): readonly ForkImportedGlobalState[] {
  const sections = WebAssembly.Module.customSections(
    module,
    WPK_FORK_IMPORTED_GLOBALS_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${WPK_FORK_IMPORTED_GLOBALS_SECTION} section, found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.byteLength < WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE) {
    throw new Error("imported-global descriptor is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true)
    !== littleEndianMagic(WPK_FORK_IMPORTED_GLOBALS_MAGIC)
  ) {
    throw new Error("imported-global descriptor has the wrong magic");
  }
  if (view.getUint16(4, true) !== WPK_FORK_IMPORTED_GLOBALS_VERSION) {
    throw new Error(
      `unsupported imported-global descriptor version ${view.getUint16(4, true)}`,
    );
  }
  if (view.getUint16(6, true) !== WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE) {
    throw new Error("imported-global descriptor declares an invalid header size");
  }
  const count = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) {
    throw new Error("imported-global descriptor reserved field is nonzero");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const owners = new Set<number>();
  const importOrdinals = new Set<number>();
  const globals: ForkImportedGlobalState[] = [];
  let previousImportOrdinal = -1;
  let offset = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE;
  for (let index = 0; index < count; index++) {
    if (offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE > bytes.byteLength) {
      throw new Error(`imported-global record ${index} header is truncated`);
    }
    const recordSize = view.getUint32(offset, true);
    const ownerId = view.getUint32(offset + 4, true);
    const typeCode = view.getUint8(offset + 8);
    const flags = view.getUint8(offset + 9);
    const moduleLength = view.getUint32(offset + 12, true);
    const nameLength = view.getUint32(offset + 16, true);
    const importOrdinal = view.getUint32(offset + 20, true);
    const expectedSize = WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
      + moduleLength
      + nameLength;
    if (
      recordSize !== expectedSize
      || recordSize < WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
      || offset + recordSize > bytes.byteLength
    ) {
      throw new Error(`imported-global record ${index} has invalid bounds`);
    }
    checkedU32(ownerId, `imported-global record ${index} owner`, false);
    if (owners.has(ownerId)) {
      throw new Error(`imported-global record ${index} duplicates owner ${ownerId}`);
    }
    owners.add(ownerId);
    if (!IMPORTED_GLOBAL_TYPE_CODES.has(typeCode)) {
      throw new Error(
        `imported-global record ${index} has unknown value type ${typeCode}`,
      );
    }
    if ((flags & ~WPK_FORK_IMPORTED_GLOBALS_KNOWN_FLAGS) !== 0) {
      throw new Error(
        `imported-global record ${index} has unknown flags 0x${flags.toString(16)}`,
      );
    }
    if (view.getUint16(offset + 10, true) !== 0) {
      throw new Error(`imported-global record ${index} reserved field is nonzero`);
    }
    const namesOffset = offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE;
    let moduleName: string;
    let fieldName: string;
    try {
      moduleName = decoder.decode(
        bytes.subarray(namesOffset, namesOffset + moduleLength),
      );
      fieldName = decoder.decode(
        bytes.subarray(
          namesOffset + moduleLength,
          namesOffset + moduleLength + nameLength,
        ),
      );
    } catch {
      throw new Error(`imported-global record ${index} contains invalid UTF-8`);
    }
    if (
      importOrdinals.has(importOrdinal)
      || importOrdinal <= previousImportOrdinal
    ) {
      throw new Error(
        `imported-global record ${index} has duplicated or unordered import ordinal`,
      );
    }
    importOrdinals.add(importOrdinal);
    previousImportOrdinal = importOrdinal;
    globals.push({
      module: moduleName,
      name: fieldName,
      importOrdinal,
      ownerId,
      typeCode,
      mutable: (flags & WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE) !== 0,
      shared: (flags & WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED) !== 0,
    });
    offset += recordSize;
  }
  if (offset !== bytes.byteLength) {
    throw new Error("imported-global descriptor has trailing bytes");
  }
  return globals;
}

const IMPORTED_TABLE_ELEMENT_TYPE_CODES = new Set<number>([
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
]);

/**
 * Read exact import-section coordinates for every application-owned table.
 *
 * A table import is an identity edge in the module graph, not just an initial
 * sequence of elements. The fresh child must wire that edge before
 * instantiation so aliases, active element initializers, and exported imported
 * tables all observe the same reconstructed Table object.
 */
export function readForkImportedTables(
  module: WebAssembly.Module,
): readonly ForkImportedTableState[] {
  const sections = WebAssembly.Module.customSections(
    module,
    WPK_FORK_IMPORTED_TABLES_SECTION,
  );
  if (sections.length !== 1) {
    throw new Error(
      `expected one ${WPK_FORK_IMPORTED_TABLES_SECTION} section, found ${sections.length}`,
    );
  }
  const bytes = new Uint8Array(sections[0]!);
  if (bytes.byteLength < WPK_FORK_IMPORTED_TABLES_HEADER_SIZE) {
    throw new Error("imported-table descriptor is truncated");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true)
    !== littleEndianMagic(WPK_FORK_IMPORTED_TABLES_MAGIC)
  ) {
    throw new Error("imported-table descriptor has the wrong magic");
  }
  if (view.getUint16(4, true) !== WPK_FORK_IMPORTED_TABLES_VERSION) {
    throw new Error(
      `unsupported imported-table descriptor version ${view.getUint16(4, true)}`,
    );
  }
  if (view.getUint16(6, true) !== WPK_FORK_IMPORTED_TABLES_HEADER_SIZE) {
    throw new Error("imported-table descriptor declares an invalid header size");
  }
  const count = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) {
    throw new Error("imported-table descriptor reserved field is nonzero");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const owners = new Set<number>();
  const importOrdinals = new Set<number>();
  const tables: ForkImportedTableState[] = [];
  let previousImportOrdinal = -1;
  let offset = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE;
  for (let index = 0; index < count; index++) {
    if (offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE > bytes.byteLength) {
      throw new Error(`imported-table record ${index} header is truncated`);
    }
    const recordSize = view.getUint32(offset, true);
    const ownerId = view.getUint32(offset + 4, true);
    const typeCode = view.getUint8(offset + 8);
    const flags = view.getUint8(offset + 9);
    const moduleLength = view.getUint32(offset + 12, true);
    const nameLength = view.getUint32(offset + 16, true);
    const importOrdinal = view.getUint32(offset + 20, true);
    const expectedSize = WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
      + moduleLength
      + nameLength;
    if (
      recordSize !== expectedSize
      || recordSize < WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
      || offset + recordSize > bytes.byteLength
    ) {
      throw new Error(`imported-table record ${index} has invalid bounds`);
    }
    checkedU32(ownerId, `imported-table record ${index} owner`, false);
    if (owners.has(ownerId)) {
      throw new Error(`imported-table record ${index} duplicates owner ${ownerId}`);
    }
    owners.add(ownerId);
    if (!IMPORTED_TABLE_ELEMENT_TYPE_CODES.has(typeCode)) {
      throw new Error(
        `imported-table record ${index} has unknown element type ${typeCode}`,
      );
    }
    if ((flags & ~WPK_FORK_IMPORTED_TABLES_KNOWN_FLAGS) !== 0) {
      throw new Error(
        `imported-table record ${index} has unknown flags 0x${flags.toString(16)}`,
      );
    }
    if (view.getUint16(offset + 10, true) !== 0) {
      throw new Error(`imported-table record ${index} reserved field is nonzero`);
    }
    const namesOffset = offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE;
    let moduleName: string;
    let fieldName: string;
    try {
      moduleName = decoder.decode(
        bytes.subarray(namesOffset, namesOffset + moduleLength),
      );
      fieldName = decoder.decode(
        bytes.subarray(
          namesOffset + moduleLength,
          namesOffset + moduleLength + nameLength,
        ),
      );
    } catch {
      throw new Error(`imported-table record ${index} contains invalid UTF-8`);
    }
    if (
      importOrdinals.has(importOrdinal)
      || importOrdinal <= previousImportOrdinal
    ) {
      throw new Error(
        `imported-table record ${index} has duplicated or unordered import ordinal`,
      );
    }
    importOrdinals.add(importOrdinal);
    previousImportOrdinal = importOrdinal;
    tables.push({
      module: moduleName,
      name: fieldName,
      importOrdinal,
      ownerId,
      typeCode,
      table64: (flags & WPK_FORK_IMPORTED_TABLES_FLAG_TABLE64) !== 0,
    });
    offset += recordSize;
  }
  if (offset !== bytes.byteLength) {
    throw new Error("imported-table descriptor has trailing bytes");
  }
  return tables;
}

/**
 * Publish the arena root in the second pointer word of the module prefix.
 *
 * WHY: the first word is the activation-frame cursor. The linked runtime has
 * reserved the `+P` word since ABI 42, so using it gives copied module state an
 * activation-owned root without changing activation-frame replay ordering.
 */
export function writeForkModuleStateRoot(
  memory: WebAssembly.Memory,
  moduleBufferAddr: number,
  ptrWidth: 4 | 8,
  arenaRoot: number,
): void {
  const moduleBuffer = checkedPointer(
    moduleBufferAddr,
    ptrWidth,
    "module-state module buffer",
    false,
  );
  const root = checkedPointer(arenaRoot, ptrWidth, "module-state arena root", true);
  if (root !== 0 && root % WASM_PAGE_SIZE !== 0) {
    throw new RangeError("module-state arena root must be page-aligned");
  }
  writePointer(
    memory,
    ptrWidth,
    moduleBuffer + FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET * ptrWidth,
    root,
  );
}

export function readForkModuleStateRoot(
  memory: WebAssembly.Memory,
  moduleBufferAddr: number,
  ptrWidth: 4 | 8,
): number {
  const moduleBuffer = checkedPointer(
    moduleBufferAddr,
    ptrWidth,
    "module-state module buffer",
    false,
  );
  const root = readPointer(
    memory,
    ptrWidth,
    moduleBuffer + FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET * ptrWidth,
    "module-state root-prefix pointer",
  );
  if (root !== 0 && root % WASM_PAGE_SIZE !== 0) {
    throw new Error("module-state root-prefix pointer is not page-aligned");
  }
  return root;
}

function encodeModulePayload(record: ForkModuleDescriptorRecord): Uint8Array {
  checkedU32(record.activationId, "module activation id");
  if (record.templateId.byteLength !== MODULE_TEMPLATE_ID_SIZE) {
    throw new RangeError(
      `module template id has ${record.templateId.byteLength} bytes, `
      + `expected ${MODULE_TEMPLATE_ID_SIZE}`,
    );
  }
  const flags = checkedU32(record.flags ?? 0, "module flags");
  if ((flags & ~MODULE_RECORD_KNOWN_FLAGS) !== 0) {
    throw new RangeError(`unknown module-state module flags 0x${flags.toString(16)}`);
  }
  const payload = new Uint8Array(MODULE_RECORD_PAYLOAD_SIZE);
  payload.set(record.templateId, 0);
  const view = new DataView(payload.buffer);
  view.setUint32(MODULE_TEMPLATE_ID_SIZE, flags, true);
  view.setUint32(MODULE_TEMPLATE_ID_SIZE + 4, 0, true);
  return payload;
}

function decodeModulePayload(payload: Uint8Array, context: string): void {
  if (payload.byteLength !== MODULE_RECORD_PAYLOAD_SIZE) {
    throw new Error(
      `${context}: module payload has ${payload.byteLength} bytes, `
      + `expected ${MODULE_RECORD_PAYLOAD_SIZE}`,
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint32(MODULE_TEMPLATE_ID_SIZE, true);
  if ((flags & ~MODULE_RECORD_KNOWN_FLAGS) !== 0) {
    throw new Error(`${context}: unknown module flags 0x${flags.toString(16)}`);
  }
  if (view.getUint32(MODULE_TEMPLATE_ID_SIZE + 4, true) !== 0) {
    throw new Error(`${context}: module payload reserved field is nonzero`);
  }
}

function encodeTableDescriptor(snapshot: ForkSparseTableSnapshot): Uint8Array {
  const indexWidth = snapshot.indexWidth;
  if (indexWidth !== 4 && indexWidth !== 8) {
    throw new RangeError(`table index width ${String(indexWidth)} is unsupported`);
  }
  if (
    !Number.isInteger(snapshot.pageShift)
    || snapshot.pageShift < MIN_TABLE_PAGE_SHIFT
    || snapshot.pageShift > MAX_TABLE_PAGE_SHIFT
  ) {
    throw new RangeError(
      `table page shift must be ${MIN_TABLE_PAGE_SHIFT}..${MAX_TABLE_PAGE_SHIFT}`,
    );
  }
  const length = checkedU64(snapshot.length, "table length");
  const baselineLength = checkedU64(snapshot.baselineLength, "table baseline length");
  if (indexWidth === 4 && length > 0xffff_ffffn) {
    throw new RangeError("table32 length exceeds u32");
  }
  if (baselineLength > length) {
    throw new RangeError("table baseline length exceeds final length");
  }
  if (
    snapshot.baselineFingerprint.byteLength
    !== FORK_MODULE_STATE_BASELINE_FINGERPRINT_SIZE
  ) {
    throw new RangeError(
      `table baseline fingerprint must be `
      + `${FORK_MODULE_STATE_BASELINE_FINGERPRINT_SIZE} bytes`,
    );
  }
  checkedU32(snapshot.pages.length, "table page count");
  const payload = new Uint8Array(TABLE_DESCRIPTOR_PAYLOAD_SIZE);
  const view = new DataView(payload.buffer);
  view.setUint8(0, indexWidth);
  view.setUint8(1, snapshot.pageShift);
  view.setUint16(2, TABLE_FLAG_SPARSE_OVERRIDES, true);
  view.setUint32(4, snapshot.pages.length, true);
  view.setBigUint64(8, length, true);
  view.setBigUint64(16, baselineLength, true);
  payload.set(snapshot.baselineFingerprint, 24);
  return payload;
}

function decodeTableDescriptor(
  record: ForkModuleStateRecord,
  context: string,
): DecodedTableDescriptor {
  if (record.payload.byteLength !== TABLE_DESCRIPTOR_PAYLOAD_SIZE) {
    throw new Error(
      `${context}: table descriptor has ${record.payload.byteLength} bytes, `
      + `expected ${TABLE_DESCRIPTOR_PAYLOAD_SIZE}`,
    );
  }
  const view = new DataView(
    record.payload.buffer,
    record.payload.byteOffset,
    record.payload.byteLength,
  );
  const indexWidth = view.getUint8(0);
  if (indexWidth !== 4 && indexWidth !== 8) {
    throw new Error(`${context}: unsupported table index width ${indexWidth}`);
  }
  const pageShift = view.getUint8(1);
  if (pageShift < MIN_TABLE_PAGE_SHIFT || pageShift > MAX_TABLE_PAGE_SHIFT) {
    throw new Error(`${context}: unsupported table page shift ${pageShift}`);
  }
  const flags = view.getUint16(2, true);
  if (
    (flags & ~TABLE_KNOWN_FLAGS) !== 0
    || (flags & TABLE_FLAG_SPARSE_OVERRIDES) === 0
  ) {
    throw new Error(`${context}: invalid table flags 0x${flags.toString(16)}`);
  }
  const length = view.getBigUint64(8, true);
  const baselineLength = view.getBigUint64(16, true);
  if (indexWidth === 4 && length > 0xffff_ffffn) {
    throw new Error(`${context}: table32 length exceeds u32`);
  }
  if (baselineLength > length) {
    throw new Error(`${context}: table baseline length exceeds final length`);
  }
  return {
    activationId: record.activationId,
    ownerId: record.ownerId,
    indexWidth,
    pageShift,
    flags,
    pageCount: view.getUint32(4, true),
    length,
    baselineLength,
    baselineFingerprint: record.payload.slice(24, 56),
  };
}

function validateSparseTablePage(
  descriptor: DecodedTableDescriptor,
  page: ForkSparseTablePage,
  previousPageIndex: bigint | null,
): ValidatedSparseTablePage {
  const pageIndex = checkedU64(page.pageIndex, "table page index");
  if (previousPageIndex !== null && pageIndex <= previousPageIndex) {
    throw new RangeError("sparse table pages must be strictly increasing");
  }
  checkedU32(page.runs.length, "table page run count");
  const pageSize = 1 << descriptor.pageShift;
  let previousEnd = 0;
  let entryCount = 0;
  let payloadSize = TABLE_PAGE_HEADER_SIZE;
  for (const [runIndex, run] of page.runs.entries()) {
    if (!Number.isInteger(run.start) || run.start < previousEnd || run.start >= pageSize) {
      throw new RangeError(`table page run ${runIndex} is unordered or out of bounds`);
    }
    if (run.recipeIds.length === 0) {
      throw new RangeError(`table page run ${runIndex} is empty`);
    }
    checkedU32(run.recipeIds.length, `table page run ${runIndex} length`, false);
    const end = run.start + run.recipeIds.length;
    if (!Number.isSafeInteger(end) || end > pageSize) {
      throw new RangeError(`table page run ${runIndex} exceeds its page`);
    }
    const absoluteEnd = pageIndex * BigInt(pageSize) + BigInt(end);
    if (absoluteEnd > descriptor.length) {
      throw new RangeError(`table page run ${runIndex} exceeds final table length`);
    }
    for (let entryIndex = 0; entryIndex < run.recipeIds.length; entryIndex++) {
      checkedU32(
        run.recipeIds[entryIndex]!,
        `table page run ${runIndex} recipe ${entryIndex}`,
      );
    }
    previousEnd = end;
    entryCount += run.recipeIds.length;
    payloadSize += TABLE_RUN_HEADER_SIZE + run.recipeIds.length * 4;
  }
  if (entryCount === 0) {
    throw new RangeError("sparse table page must contain at least one override");
  }
  checkedU32(entryCount, "table page entry count");
  return { pageIndex, entryCount, payloadSize };
}

function encodeTablePage(
  descriptor: DecodedTableDescriptor,
  page: ForkSparseTablePage,
  previousPageIndex: bigint | null,
): Uint8Array {
  const validated = validateSparseTablePage(
    descriptor,
    page,
    previousPageIndex,
  );
  const payload = new Uint8Array(validated.payloadSize);
  const view = new DataView(payload.buffer);
  view.setBigUint64(0, validated.pageIndex, true);
  view.setUint32(8, page.runs.length, true);
  view.setUint32(12, validated.entryCount, true);
  let offset = TABLE_PAGE_HEADER_SIZE;
  for (const run of page.runs) {
    view.setUint32(offset, run.start, true);
    view.setUint32(offset + 4, run.recipeIds.length, true);
    offset += TABLE_RUN_HEADER_SIZE;
    for (const recipeId of run.recipeIds) {
      view.setUint32(offset, recipeId, true);
      offset += 4;
    }
  }
  return payload;
}

function validateTablePage(
  record: ForkModuleStateRecord,
  descriptor: DecodedTableDescriptor,
  context: string,
): ValidatedTablePage {
  if (record.payload.byteLength < TABLE_PAGE_HEADER_SIZE) {
    throw new Error(`${context}: table page payload is truncated`);
  }
  const view = new DataView(
    record.payload.buffer,
    record.payload.byteOffset,
    record.payload.byteLength,
  );
  const pageIndex = view.getBigUint64(0, true);
  const runCount = view.getUint32(8, true);
  const declaredEntryCount = view.getUint32(12, true);
  const pageSize = 1 << descriptor.pageShift;
  let previousEnd = 0;
  let entryCount = 0;
  let offset = TABLE_PAGE_HEADER_SIZE;
  for (let runIndex = 0; runIndex < runCount; runIndex++) {
    if (offset + TABLE_RUN_HEADER_SIZE > record.payload.byteLength) {
      throw new Error(`${context}: table page run ${runIndex} header is truncated`);
    }
    const start = view.getUint32(offset, true);
    const count = view.getUint32(offset + 4, true);
    offset += TABLE_RUN_HEADER_SIZE;
    if (count === 0 || start < previousEnd || start >= pageSize || start + count > pageSize) {
      throw new Error(`${context}: table page run ${runIndex} is unordered or out of bounds`);
    }
    if (offset + count * 4 > record.payload.byteLength) {
      throw new Error(`${context}: table page run ${runIndex} recipes are truncated`);
    }
    const absoluteEnd = pageIndex * BigInt(pageSize) + BigInt(start + count);
    if (absoluteEnd > descriptor.length) {
      throw new Error(`${context}: table page run ${runIndex} exceeds final table length`);
    }
    // WHY: attachment only needs structural validity and page ordering. Read
    // each recipe in place so validating an arbitrarily long segmented table
    // does not allocate and immediately discard one Uint32Array per run.
    for (let index = 0; index < count; index++) {
      view.getUint32(offset, true);
      offset += 4;
    }
    previousEnd = start + count;
    entryCount += count;
  }
  if (
    runCount === 0
    || entryCount !== declaredEntryCount
    || offset !== record.payload.byteLength
  ) {
    throw new Error(`${context}: table page counts or payload size are inconsistent`);
  }
  return { pageIndex, runCount, entryCount };
}

function decodeTablePage(
  record: ForkModuleStateRecord,
  descriptor: DecodedTableDescriptor,
  context: string,
): DecodedTablePage {
  const validated = validateTablePage(record, descriptor, context);
  const view = new DataView(
    record.payload.buffer,
    record.payload.byteOffset,
    record.payload.byteLength,
  );
  let offset = TABLE_PAGE_HEADER_SIZE;
  const runs: DecodedForkSparseTableRun[] = [];
  for (let runIndex = 0; runIndex < validated.runCount; runIndex++) {
    const start = view.getUint32(offset, true);
    const count = view.getUint32(offset + 4, true);
    offset += TABLE_RUN_HEADER_SIZE;
    const recipeIds = new Uint32Array(count);
    for (let index = 0; index < count; index++) {
      recipeIds[index] = view.getUint32(offset, true);
      offset += 4;
    }
    runs.push({ start, recipeIds });
  }
  return {
    activationId: record.activationId,
    ownerId: record.ownerId,
    pageIndex: validated.pageIndex,
    runs,
    entryCount: validated.entryCount,
  };
}

function encodeSegmentBitmap(
  state: ForkElementSegmentState | ForkDataSegmentState,
  label: "element" | "data",
  headerSize: number,
): Uint8Array {
  checkedU32(state.segmentCount, `${label} segment count`);
  const expectedBytes = Math.ceil(state.segmentCount / 8);
  if (state.dropped.byteLength !== expectedBytes) {
    throw new RangeError(
      `${label} drop bitmap has ${state.dropped.byteLength} bytes, expected ${expectedBytes}`,
    );
  }
  if (expectedBytes > 0 && state.segmentCount % 8 !== 0) {
    const liveBits = state.segmentCount % 8;
    const invalidMask = 0xff << liveBits;
    if ((state.dropped[expectedBytes - 1]! & invalidMask) !== 0) {
      throw new RangeError(`${label} drop bitmap has nonzero bits beyond segment count`);
    }
  }
  const payload = new Uint8Array(headerSize + expectedBytes);
  const view = new DataView(payload.buffer);
  view.setUint32(0, state.segmentCount, true);
  view.setUint32(4, expectedBytes, true);
  payload.set(state.dropped, headerSize);
  return payload;
}

function decodeSegmentBitmap(
  payload: Uint8Array,
  context: string,
  label: "element" | "data",
  headerSize: number,
): void {
  if (payload.byteLength < headerSize) {
    throw new Error(`${context}: ${label}-segment payload is truncated`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const segmentCount = view.getUint32(0, true);
  const bitmapBytes = view.getUint32(4, true);
  const expectedBytes = Math.ceil(segmentCount / 8);
  if (
    bitmapBytes !== expectedBytes
    || payload.byteLength !== headerSize + expectedBytes
  ) {
    throw new Error(`${context}: ${label}-segment bitmap size is inconsistent`);
  }
  if (expectedBytes > 0 && segmentCount % 8 !== 0) {
    const invalidMask = 0xff << (segmentCount % 8);
    if ((payload[payload.byteLength - 1]! & invalidMask) !== 0) {
      throw new Error(`${context}: ${label}-segment bitmap has nonzero trailing bits`);
    }
  }
}

function encodeElementSegments(state: ForkElementSegmentState): Uint8Array {
  return encodeSegmentBitmap(state, "element", ELEMENT_SEGMENT_HEADER_SIZE);
}

function encodeDataSegments(state: ForkDataSegmentState): Uint8Array {
  return encodeSegmentBitmap(state, "data", DATA_SEGMENT_HEADER_SIZE);
}

function decodeElementSegments(payload: Uint8Array, context: string): void {
  decodeSegmentBitmap(payload, context, "element", ELEMENT_SEGMENT_HEADER_SIZE);
}

function decodeDataSegments(payload: Uint8Array, context: string): void {
  decodeSegmentBitmap(payload, context, "data", DATA_SEGMENT_HEADER_SIZE);
}

function assertActivationContinuationSet(
  continuations: readonly ForkActivationContinuation[],
  activeActivationIds: ReadonlySet<number>,
  context: string,
): void {
  const expected = [...activeActivationIds].sort((left, right) => left - right);
  const actual = continuations.map(({ activationId }) => activationId);
  if (
    actual.length !== expected.length
    || actual.some((activationId, index) => activationId !== expected[index])
  ) {
    throw new Error(
      `${context}: activation set does not exactly match replay events `
      + `(continuations ${actual.join(",")}; replay ${expected.join(",")})`,
    );
  }
}

/**
 * Encode the copied continuation root for every activation participating in
 * this fork. Roots are fixed-width u64 values so one process record can name
 * wasm32 and wasm64 activations without an archive-private side channel.
 */
export function encodeForkActivationContinuations(
  continuations: readonly ForkActivationContinuation[],
): Uint8Array {
  if (continuations.length === 0) {
    throw new Error("activation-continuation manifest must not be empty");
  }
  if (continuations.length > 0xffff_ffff) {
    throw new RangeError("activation-continuation count exceeds u32");
  }
  const payloadSize = WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE
    + continuations.length * WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE;
  if (!Number.isSafeInteger(payloadSize)) {
    throw new RangeError(
      "activation-continuation payload size exceeds JavaScript safe integer",
    );
  }
  const payload = new Uint8Array(payloadSize);
  const view = new DataView(payload.buffer);
  view.setUint32(
    0,
    littleEndianMagic(WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC),
    true,
  );
  view.setUint16(4, WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION, true);
  view.setUint16(6, WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE, true);
  view.setUint16(8, WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE, true);
  view.setUint16(10, WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS, true);
  view.setUint32(12, continuations.length, true);
  view.setBigUint64(16, 0n, true);

  let previousActivation = -1;
  for (const [index, continuation] of continuations.entries()) {
    checkedU32(
      continuation.activationId,
      `activation continuation ${index} activation`,
    );
    if (continuation.activationId <= previousActivation) {
      throw new Error(
        `activation continuation ${index}: activations must be unique and strictly ordered`,
      );
    }
    const root = checkedU64(
      continuation.root,
      `activation continuation ${index} root`,
    );
    if (root === 0n) {
      throw new RangeError(`activation continuation ${index} root is zero`);
    }
    const offset = WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE
      + index * WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE;
    view.setUint32(offset, continuation.activationId, true);
    view.setUint32(
      offset + 4,
      WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_KNOWN_FLAGS,
      true,
    );
    view.setBigUint64(offset + 8, root, true);
    previousActivation = continuation.activationId;
  }
  return payload;
}

export function decodeForkActivationContinuations(
  payload: Uint8Array,
  context = "module-state activation continuations",
): ForkActivationContinuation[] {
  if (payload.byteLength < WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE) {
    throw new Error(`${context}: payload is truncated`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (
    view.getUint32(0, true)
    !== littleEndianMagic(WPK_FORK_ACTIVATION_CONTINUATIONS_MAGIC)
  ) {
    throw new Error(`${context}: wrong magic`);
  }
  const version = view.getUint16(4, true);
  if (version !== WPK_FORK_ACTIVATION_CONTINUATIONS_VERSION) {
    throw new Error(`${context}: unsupported version ${version}`);
  }
  if (
    view.getUint16(6, true) !== WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE
    || view.getUint16(8, true) !== WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE
  ) {
    throw new Error(`${context}: header or entry size is inconsistent`);
  }
  const flags = view.getUint16(10, true);
  if ((flags & ~WPK_FORK_ACTIVATION_CONTINUATIONS_KNOWN_FLAGS) !== 0) {
    throw new Error(`${context}: unknown flags 0x${flags.toString(16)}`);
  }
  const count = view.getUint32(12, true);
  if (view.getBigUint64(16, true) !== 0n) {
    throw new Error(`${context}: reserved header field is nonzero`);
  }
  const expectedSize = WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE
    + count * WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE;
  if (payload.byteLength !== expectedSize) {
    throw new Error(`${context}: entry count is inconsistent with payload size`);
  }
  if (count === 0) {
    throw new Error(`${context}: manifest is empty`);
  }

  const continuations: ForkActivationContinuation[] = [];
  let previousActivation = -1;
  for (let index = 0; index < count; index++) {
    const offset = WPK_FORK_ACTIVATION_CONTINUATIONS_HEADER_SIZE
      + index * WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_SIZE;
    const activationId = view.getUint32(offset, true);
    const entryFlags = view.getUint32(offset + 4, true);
    if (
      (entryFlags & ~WPK_FORK_ACTIVATION_CONTINUATIONS_ENTRY_KNOWN_FLAGS) !== 0
    ) {
      throw new Error(
        `${context} entry ${index}: unknown flags 0x${entryFlags.toString(16)}`,
      );
    }
    if (activationId <= previousActivation) {
      throw new Error(
        `${context} entry ${index}: activations are duplicated or unordered`,
      );
    }
    const root = view.getBigUint64(offset + 8, true);
    if (root === 0n) {
      throw new Error(`${context} entry ${index}: continuation root is zero`);
    }
    continuations.push({ activationId, root });
    previousActivation = activationId;
  }
  return continuations;
}

/**
 * Encode a `JournalImage` manifest: the guest offset + byte length of the
 * channel-mmap'd KFRE journal image. Fixed 32-byte payload (see the shared ABI
 * layout): magic, version, header_size, flags, reserved, ptr u64, len u64.
 */
export function encodeForkJournalImage(image: ForkJournalImage): Uint8Array {
  const ptr = checkedU64(image.ptr, "journal image ptr");
  const len = checkedU64(image.len, "journal image len");
  if (ptr === 0n) {
    throw new RangeError("journal image ptr is zero");
  }
  if (len === 0n) {
    throw new RangeError("journal image len is zero");
  }
  const payload = new Uint8Array(WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE);
  const view = new DataView(payload.buffer);
  view.setUint32(0, littleEndianMagic(WPK_FORK_JOURNAL_IMAGE_MAGIC), true);
  view.setUint16(4, WPK_FORK_JOURNAL_IMAGE_VERSION, true);
  view.setUint16(6, WPK_FORK_JOURNAL_IMAGE_HEADER_SIZE, true);
  view.setUint16(8, WPK_FORK_JOURNAL_IMAGE_KNOWN_FLAGS, true);
  view.setUint16(10, 0, true);
  view.setUint32(12, 0, true);
  view.setBigUint64(16, ptr, true);
  view.setBigUint64(24, len, true);
  return payload;
}

export function decodeForkJournalImage(
  payload: Uint8Array,
  context = "module-state journal image",
): ForkJournalImage {
  if (payload.byteLength !== WPK_FORK_JOURNAL_IMAGE_PAYLOAD_SIZE) {
    throw new Error(`${context}: payload size is inconsistent`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (view.getUint32(0, true) !== littleEndianMagic(WPK_FORK_JOURNAL_IMAGE_MAGIC)) {
    throw new Error(`${context}: wrong magic`);
  }
  const version = view.getUint16(4, true);
  if (version !== WPK_FORK_JOURNAL_IMAGE_VERSION) {
    throw new Error(`${context}: unsupported version ${version}`);
  }
  if (view.getUint16(6, true) !== WPK_FORK_JOURNAL_IMAGE_HEADER_SIZE) {
    throw new Error(`${context}: header size is inconsistent`);
  }
  const flags = view.getUint16(8, true);
  if ((flags & ~WPK_FORK_JOURNAL_IMAGE_KNOWN_FLAGS) !== 0) {
    throw new Error(`${context}: unknown flags 0x${flags.toString(16)}`);
  }
  if (view.getUint16(10, true) !== 0 || view.getUint32(12, true) !== 0) {
    throw new Error(`${context}: reserved header field is nonzero`);
  }
  const ptr = view.getBigUint64(16, true);
  const len = view.getBigUint64(24, true);
  if (ptr === 0n) {
    throw new Error(`${context}: image ptr is zero`);
  }
  if (len === 0n) {
    throw new Error(`${context}: image len is zero`);
  }
  return { ptr, len };
}

/**
 * Recover the single `JournalImage` record from an inherited child arena
 * (Option B). Mirrors `activationContinuationsForChild` — exactly one record,
 * activation 0, the journal-image owner — and validates the pointer/length fit
 * the guest pointer width so the child seeds its replay from a real offset.
 */
export function journalImageForChild(
  records: readonly ForkModuleStateRecordView[],
  ptrWidth: 4 | 8,
): ForkJournalImage {
  const matches = records.filter(
    (record) => record.kind === ForkModuleStateRecordKind.JournalImage,
  );
  if (matches.length !== 1) {
    throw new Error(
      `module-state arena has ${matches.length} journal-image records; expected one`,
    );
  }
  const record = matches[0]!;
  if (
    record.activationId !== 0
    || record.ownerId !== WPK_FORK_JOURNAL_IMAGE_OWNER
  ) {
    throw new Error("module-state journal image has invalid ownership");
  }
  const image = decodeForkJournalImage(record.payload);
  const maxAddr = ptrWidth === 4 ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
  if (image.ptr > maxAddr || image.len > maxAddr) {
    throw new RangeError(
      `module-state journal image does not fit wasm${ptrWidth * 8}`,
    );
  }
  return image;
}

const IMPORTED_GLOBAL_BINDING_KINDS = new Set<number>(
  Object.values(ForkImportedGlobalBindingKind),
);

function importedGlobalBindingFlags(binding: ForkImportedGlobalBinding): number {
  return (binding.mutable ? WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE : 0)
    | (binding.shared ? WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED : 0);
}

function validateImportedGlobalBinding(
  binding: ForkImportedGlobalBinding,
  context: string,
): void {
  checkedU32(binding.consumerActivation, `${context} consumer activation`);
  checkedU32(binding.consumerOwner, `${context} consumer owner`, false);
  checkedU32(binding.sourceActivation, `${context} source activation`);
  checkedU32(binding.sourceOwner, `${context} source owner`);
  checkedU32(binding.reserved, `${context} reserved field`);
  checkedU32(binding.recipeId, `${context} recipe id`);
  checkedU64(binding.rawBits, `${context} raw bits`);
  if (!IMPORTED_GLOBAL_BINDING_KINDS.has(binding.kind)) {
    throw new Error(`${context}: unknown binding kind ${binding.kind}`);
  }
  if (!IMPORTED_GLOBAL_TYPE_CODES.has(binding.typeCode)) {
    throw new Error(`${context}: unknown value type ${binding.typeCode}`);
  }

  const zeroSource = (): boolean =>
    binding.sourceActivation === 0 && binding.sourceOwner === 0;
  const zeroRaw = (): boolean => binding.rawBits === 0n;
  switch (binding.kind) {
    case ForkImportedGlobalBindingKind.RawNumber:
    case ForkImportedGlobalBindingKind.RawBigInt:
      if (!zeroSource() || binding.reserved !== 0 || binding.recipeId !== 0) {
        throw new Error(`${context}: raw scalar binding has nonzero owner fields`);
      }
      break;
    case ForkImportedGlobalBindingKind.RawReference:
      if (!zeroSource() || binding.reserved !== 0 || !zeroRaw()) {
        throw new Error(`${context}: raw reference binding has nonzero owner fields`);
      }
      break;
    case ForkImportedGlobalBindingKind.ActivationGlobal:
      if (
        binding.sourceOwner === 0
        || binding.reserved !== 0
        || binding.recipeId !== 0
        || !zeroRaw()
      ) {
        throw new Error(`${context}: activation-global binding fields are inconsistent`);
      }
      break;
    case ForkImportedGlobalBindingKind.BaseImport:
      if (
        binding.reserved !== 0
        || !zeroSource()
        || binding.recipeId !== 0
        || !zeroRaw()
      ) {
        throw new Error(`${context}: base-import binding fields are inconsistent`);
      }
      break;
  }
}

/**
 * Encode the process-wide provenance of every imported global declaration.
 *
 * Entries are declaration-owned, while repeated `(module,name)` properties
 * intentionally carry the same raw recipe/provider coordinates. This keeps
 * independent Wasm coercions valid without losing the JavaScript binding that
 * produced them.
 */
export function encodeForkImportedGlobalBindings(
  bindings: readonly ForkImportedGlobalBinding[],
): Uint8Array {
  if (bindings.length > 0xffff_ffff) {
    throw new RangeError("imported-global binding count exceeds u32");
  }
  const payloadSize = WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE
    + bindings.length * WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE;
  if (!Number.isSafeInteger(payloadSize)) {
    throw new RangeError(
      "imported-global binding payload size exceeds JavaScript safe integer",
    );
  }
  const payload = new Uint8Array(payloadSize);
  const view = new DataView(payload.buffer);
  view.setUint32(
    0,
    littleEndianMagic(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC),
    true,
  );
  view.setUint16(4, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE, true);
  view.setUint16(8, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE, true);
  view.setUint16(10, WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS, true);
  view.setUint32(12, bindings.length, true);
  view.setBigUint64(16, 0n, true);

  let previousKey = "";
  for (const [index, binding] of bindings.entries()) {
    const context = `imported-global binding ${index}`;
    validateImportedGlobalBinding(binding, context);
    const key = `${binding.consumerActivation.toString(16).padStart(8, "0")}:`
      + binding.consumerOwner.toString(16).padStart(8, "0");
    if (key <= previousKey) {
      throw new Error(
        `${context}: consumer declarations must be unique and strictly ordered`,
      );
    }
    previousKey = key;
    const offset = WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE
      + index * WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE;
    view.setUint32(offset, binding.consumerActivation, true);
    view.setUint32(offset + 4, binding.consumerOwner, true);
    view.setUint32(offset + 8, binding.sourceActivation, true);
    view.setUint32(offset + 12, binding.sourceOwner, true);
    view.setUint32(offset + 16, binding.reserved, true);
    view.setUint32(offset + 20, binding.recipeId, true);
    view.setBigUint64(offset + 24, binding.rawBits, true);
    view.setUint8(offset + 32, binding.kind);
    view.setUint8(offset + 33, importedGlobalBindingFlags(binding));
    view.setUint8(offset + 34, binding.typeCode);
  }
  return payload;
}

export function decodeForkImportedGlobalBindings(
  payload: Uint8Array,
  context = "module-state imported-global bindings",
): ForkImportedGlobalBinding[] {
  if (payload.byteLength < WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE) {
    throw new Error(`${context}: payload is truncated`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (
    view.getUint32(0, true)
    !== littleEndianMagic(WPK_FORK_IMPORTED_GLOBAL_BINDINGS_MAGIC)
  ) {
    throw new Error(`${context}: wrong magic`);
  }
  if (view.getUint16(4, true) !== WPK_FORK_IMPORTED_GLOBAL_BINDINGS_VERSION) {
    throw new Error(`${context}: unsupported version ${view.getUint16(4, true)}`);
  }
  if (
    view.getUint16(6, true) !== WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE
    || view.getUint16(8, true) !== WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE
  ) {
    throw new Error(`${context}: header or entry size is inconsistent`);
  }
  const flags = view.getUint16(10, true);
  if ((flags & ~WPK_FORK_IMPORTED_GLOBAL_BINDINGS_KNOWN_FLAGS) !== 0) {
    throw new Error(`${context}: unknown flags 0x${flags.toString(16)}`);
  }
  const count = view.getUint32(12, true);
  if (view.getBigUint64(16, true) !== 0n) {
    throw new Error(`${context}: reserved header field is nonzero`);
  }
  const expectedSize = WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE
    + count * WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE;
  if (payload.byteLength !== expectedSize) {
    throw new Error(`${context}: entry count is inconsistent with payload size`);
  }

  const bindings: ForkImportedGlobalBinding[] = [];
  let previousKey = "";
  for (let index = 0; index < count; index++) {
    const offset = WPK_FORK_IMPORTED_GLOBAL_BINDINGS_HEADER_SIZE
      + index * WPK_FORK_IMPORTED_GLOBAL_BINDINGS_ENTRY_SIZE;
    if (view.getUint8(offset + 35) !== 0 || view.getUint32(offset + 36, true) !== 0) {
      throw new Error(`${context} entry ${index}: reserved fields are nonzero`);
    }
    const entryFlags = view.getUint8(offset + 33);
    if ((entryFlags & ~WPK_FORK_IMPORTED_GLOBALS_KNOWN_FLAGS) !== 0) {
      throw new Error(
        `${context} entry ${index}: unknown flags 0x${entryFlags.toString(16)}`,
      );
    }
    const binding: ForkImportedGlobalBinding = {
      consumerActivation: view.getUint32(offset, true),
      consumerOwner: view.getUint32(offset + 4, true),
      sourceActivation: view.getUint32(offset + 8, true),
      sourceOwner: view.getUint32(offset + 12, true),
      reserved: view.getUint32(offset + 16, true),
      recipeId: view.getUint32(offset + 20, true),
      rawBits: view.getBigUint64(offset + 24, true),
      kind: view.getUint8(offset + 32) as ForkImportedGlobalBindingKind,
      mutable: (entryFlags & WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE) !== 0,
      shared: (entryFlags & WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED) !== 0,
      typeCode: view.getUint8(offset + 34),
    };
    validateImportedGlobalBinding(binding, `${context} entry ${index}`);
    const key = `${binding.consumerActivation.toString(16).padStart(8, "0")}:`
      + binding.consumerOwner.toString(16).padStart(8, "0");
    if (key <= previousKey) {
      throw new Error(
        `${context} entry ${index}: consumer declarations are duplicated or unordered`,
      );
    }
    previousKey = key;
    bindings.push(binding);
  }
  return bindings;
}

const IMPORTED_TABLE_BINDING_KINDS = new Set<number>(
  Object.values(ForkImportedTableBindingKind),
);

function validateImportedTableBinding(
  binding: ForkImportedTableBinding,
  context: string,
): void {
  checkedU32(binding.consumerActivation, `${context} consumer activation`);
  checkedU32(binding.consumerOwner, `${context} consumer owner`, false);
  checkedU32(binding.sourceActivation, `${context} source activation`);
  checkedU32(binding.sourceOwner, `${context} source owner`);
  checkedU32(binding.reserved, `${context} reserved field`);
  if (!IMPORTED_TABLE_BINDING_KINDS.has(binding.kind)) {
    throw new Error(`${context}: unknown binding kind ${binding.kind}`);
  }
  switch (binding.kind) {
    case ForkImportedTableBindingKind.ActivationTable:
      if (binding.sourceOwner === 0 || binding.reserved !== 0) {
        throw new Error(`${context}: activation-table binding fields are inconsistent`);
      }
      break;
    case ForkImportedTableBindingKind.BaseImport:
      if (
        binding.sourceActivation !== 0
        || binding.sourceOwner !== 0
        || binding.reserved !== 0
      ) {
        throw new Error(`${context}: base-import binding fields are inconsistent`);
      }
      break;
  }
}

/**
 * Encode the process-wide identity graph for imported Table declarations.
 *
 * KFMS table records own element contents. This manifest separately owns
 * pre-instantiation identity: every consumer declaration is wired either to a
 * table exported by another activation or re-resolved through the child's
 * exact base import builder. The split avoids copying a full table per
 * activation while preserving aliases.
 */
export function encodeForkImportedTableBindings(
  bindings: readonly ForkImportedTableBinding[],
): Uint8Array {
  if (bindings.length > 0xffff_ffff) {
    throw new RangeError("imported-table binding count exceeds u32");
  }
  const payloadSize = WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE
    + bindings.length * WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE;
  if (!Number.isSafeInteger(payloadSize)) {
    throw new RangeError(
      "imported-table binding payload size exceeds JavaScript safe integer",
    );
  }
  const payload = new Uint8Array(payloadSize);
  const view = new DataView(payload.buffer);
  view.setUint32(
    0,
    littleEndianMagic(WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC),
    true,
  );
  view.setUint16(4, WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE, true);
  view.setUint16(8, WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE, true);
  view.setUint16(10, WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS, true);
  view.setUint32(12, bindings.length, true);
  view.setBigUint64(16, 0n, true);

  let previousKey = "";
  for (const [index, binding] of bindings.entries()) {
    const context = `imported-table binding ${index}`;
    validateImportedTableBinding(binding, context);
    const key = `${binding.consumerActivation.toString(16).padStart(8, "0")}:`
      + binding.consumerOwner.toString(16).padStart(8, "0");
    if (key <= previousKey) {
      throw new Error(
        `${context}: consumer declarations must be unique and strictly ordered`,
      );
    }
    previousKey = key;
    const offset = WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE
      + index * WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE;
    view.setUint32(offset, binding.consumerActivation, true);
    view.setUint32(offset + 4, binding.consumerOwner, true);
    view.setUint32(offset + 8, binding.sourceActivation, true);
    view.setUint32(offset + 12, binding.sourceOwner, true);
    view.setUint32(offset + 16, binding.reserved, true);
    view.setUint8(offset + 20, binding.kind);
  }
  return payload;
}

export function decodeForkImportedTableBindings(
  payload: Uint8Array,
  context = "module-state imported-table bindings",
): ForkImportedTableBinding[] {
  if (payload.byteLength < WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE) {
    throw new Error(`${context}: payload is truncated`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (
    view.getUint32(0, true)
    !== littleEndianMagic(WPK_FORK_IMPORTED_TABLE_BINDINGS_MAGIC)
  ) {
    throw new Error(`${context}: wrong magic`);
  }
  if (view.getUint16(4, true) !== WPK_FORK_IMPORTED_TABLE_BINDINGS_VERSION) {
    throw new Error(`${context}: unsupported version ${view.getUint16(4, true)}`);
  }
  if (
    view.getUint16(6, true) !== WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE
    || view.getUint16(8, true) !== WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE
  ) {
    throw new Error(`${context}: header or entry size is inconsistent`);
  }
  const flags = view.getUint16(10, true);
  if ((flags & ~WPK_FORK_IMPORTED_TABLE_BINDINGS_KNOWN_FLAGS) !== 0) {
    throw new Error(`${context}: unknown flags 0x${flags.toString(16)}`);
  }
  const count = view.getUint32(12, true);
  if (view.getBigUint64(16, true) !== 0n) {
    throw new Error(`${context}: reserved header field is nonzero`);
  }
  const expectedSize = WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE
    + count * WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE;
  if (payload.byteLength !== expectedSize) {
    throw new Error(`${context}: entry count is inconsistent with payload size`);
  }

  const bindings: ForkImportedTableBinding[] = [];
  let previousKey = "";
  for (let index = 0; index < count; index++) {
    const offset = WPK_FORK_IMPORTED_TABLE_BINDINGS_HEADER_SIZE
      + index * WPK_FORK_IMPORTED_TABLE_BINDINGS_ENTRY_SIZE;
    if (view.getUint8(offset + 21) !== 0 || view.getUint16(offset + 22, true) !== 0) {
      throw new Error(`${context} entry ${index}: reserved fields are nonzero`);
    }
    const binding: ForkImportedTableBinding = {
      consumerActivation: view.getUint32(offset, true),
      consumerOwner: view.getUint32(offset + 4, true),
      sourceActivation: view.getUint32(offset + 8, true),
      sourceOwner: view.getUint32(offset + 12, true),
      reserved: view.getUint32(offset + 16, true),
      kind: view.getUint8(offset + 20) as ForkImportedTableBindingKind,
    };
    validateImportedTableBinding(binding, `${context} entry ${index}`);
    const key = `${binding.consumerActivation.toString(16).padStart(8, "0")}:`
      + binding.consumerOwner.toString(16).padStart(8, "0");
    if (key <= previousKey) {
      throw new Error(
        `${context} entry ${index}: consumer declarations are duplicated or unordered`,
      );
    }
    previousKey = key;
    bindings.push(binding);
  }
  return bindings;
}

export function importedGlobalBindingsForChild(
  records: readonly ForkModuleStateRecord[],
): ForkImportedGlobalBinding[] {
  const matches = records.filter(
    (record) => record.kind === ForkModuleStateRecordKind.ImportedGlobalBindings,
  );
  if (matches.length !== 1) {
    throw new Error(
      `module-state arena has ${matches.length} imported-global binding records; expected one`,
    );
  }
  const record = matches[0]!;
  if (
    record.activationId !== 0
    || record.ownerId !== WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER
  ) {
    throw new Error("module-state imported-global bindings have invalid ownership");
  }
  return decodeForkImportedGlobalBindings(record.payload);
}

export function importedTableBindingsForChild(
  records: readonly ForkModuleStateRecord[],
): ForkImportedTableBinding[] {
  const matches = records.filter(
    (record) => record.kind === ForkModuleStateRecordKind.ImportedTableBindings,
  );
  if (matches.length !== 1) {
    throw new Error(
      `module-state arena has ${matches.length} imported-table binding records; expected one`,
    );
  }
  const record = matches[0]!;
  if (
    record.activationId !== 0
    || record.ownerId !== WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER
  ) {
    throw new Error("module-state imported-table bindings have invalid ownership");
  }
  return decodeForkImportedTableBindings(record.payload);
}

export function activationContinuationsForChild(
  records: readonly ForkModuleStateRecordView[],
  ptrWidth: 4 | 8,
): ForkActivationContinuation[] {
  const matches = records.filter(
    (record) => record.kind === ForkModuleStateRecordKind.ActivationContinuations,
  );
  if (matches.length !== 1) {
    throw new Error(
      `module-state arena has ${matches.length} activation-continuation records; expected one`,
    );
  }
  const record = matches[0]!;
  if (
    record.activationId !== 0
    || record.ownerId !== WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER
  ) {
    throw new Error("module-state activation continuations have invalid ownership");
  }
  const continuations = decodeForkActivationContinuations(record.payload);
  const replay = validateForkReplayEventWire(replayEventsForChild(records));
  assertActivationContinuationSet(
    continuations,
    replay.activationIds,
    "module-state activation continuations",
  );
  const maxRoot = ptrWidth === 4 ? 0xffff_ffffn : 0xffff_ffff_ffff_ffffn;
  for (const continuation of continuations) {
    if (continuation.root > maxRoot) {
      throw new RangeError(
        `module-state activation ${continuation.activationId} continuation root `
        + `does not fit wasm${ptrWidth * 8}`,
      );
    }
  }
  return continuations;
}

/** Select and validate the ordered process replay-event segment stream. */
export function replayEventsForChild(
  records: readonly ForkModuleStateRecordView[],
): ForkReplayEventWire {
  let manifest: Uint8Array | null = null;
  for (const record of records) {
    if (
      record.kind !== ForkModuleStateRecordKind.ReplayEventSegment
      && record.kind !== ForkModuleStateRecordKind.ReplayEvents
    ) {
      continue;
    }
    if (
      record.activationId !== 0
      || record.ownerId !== WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER
    ) {
      throw new Error("module-state replay events have invalid process ownership");
    }
    if (record.kind === ForkModuleStateRecordKind.ReplayEventSegment) {
      if (manifest) {
        throw new Error(
          "module-state replay-event segment follows its final manifest",
        );
      }
      continue;
    }
    if (manifest) {
      throw new Error("module-state arena has duplicate process replay-event records");
    }
    manifest = record.payload;
  }
  if (!manifest) {
    throw new Error("module-state arena has no process replay-event manifest");
  }
  const segments: Iterable<Uint8Array> = {
    *[Symbol.iterator]() {
      for (const record of records) {
        if (record.kind === ForkModuleStateRecordKind.ReplayEventSegment) {
          yield record.payload;
        }
      }
    },
  };
  const wire = { manifest, segments };
  validateForkReplayEventWire(wire);
  return wire;
}

export function decodeForkGlobalSnapshot(
  payload: Uint8Array,
  context = "module-state global",
): ForkGlobalSnapshot {
  if (payload.byteLength < GLOBAL_HEADER_SIZE) {
    throw new Error(`${context}: mutable-global payload is truncated`);
  }
  const valueSizes = new Map<number, number>([
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32, 4],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64, 8],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32, 4],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64, 8],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128, 16],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF, 4],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF, 4],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF, 4],
    [WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF, 4],
  ]);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const type = view.getUint8(0);
  const expectedValueSize = valueSizes.get(type);
  if (expectedValueSize === undefined) {
    throw new Error(`${context}: unknown mutable-global value type ${type}`);
  }
  const valueSize = view.getUint8(1);
  if (
    valueSize !== expectedValueSize
    || payload.byteLength !== GLOBAL_HEADER_SIZE + expectedValueSize
  ) {
    throw new Error(`${context}: mutable-global value size is inconsistent`);
  }
  if (view.getUint16(2, true) !== 0 || view.getUint32(4, true) !== 0) {
    throw new Error(`${context}: mutable-global reserved fields are nonzero`);
  }
  const value = payload.slice(GLOBAL_HEADER_SIZE);
  const snapshot: ForkGlobalSnapshot = { typeCode: type, value };
  if (
    type === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF
    || type === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF
    || type === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF
    || type === WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF
  ) {
    snapshot.recipeId = new DataView(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).getUint32(0, true);
  }
  return snapshot;
}

export function findForkGlobalSnapshot(
  records: readonly ForkModuleStateRecord[],
  activationId: number,
  ownerId: number,
): ForkGlobalSnapshot {
  checkedU32(activationId, "global snapshot activation");
  checkedU32(ownerId, "global snapshot owner", false);
  const matches = records.filter(
    (record) =>
      record.kind === ForkModuleStateRecordKind.MutableGlobal
      && record.activationId === activationId
      && record.ownerId === ownerId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `module-state has ${matches.length} global snapshots for `
      + `${activationId}:${ownerId}; expected one`,
    );
  }
  return decodeForkGlobalSnapshot(
    matches[0]!.payload,
    `module-state global ${activationId}:${ownerId}`,
  );
}

function validateRecordOwnership(
  records: readonly ForkModuleStateRecord[],
  ptrWidth?: 4 | 8,
): void {
  const modules = new Set<number>();
  const owned = new Set<string>();
  const tables = new Map<string, DecodedTableDescriptor>();
  const tablePageCounts = new Map<string, number>();
  const lastTablePages = new Map<string, bigint>();
  let replayEventsSeen = false;
  let replayEventSegments = 0;
  let referenceRecipeSeen = false;
  let referenceRecipeSegments = 0;
  let importedGlobalBindingsSeen = false;
  let importedTableBindingsSeen = false;
  let journalImageSeen = false;
  let replayEventManifest: Uint8Array | null = null;
  let activationContinuations: ForkActivationContinuation[] | null = null;

  for (const [recordIndex, record] of records.entries()) {
    const context = `module-state record ${recordIndex}`;
    checkedU32(record.activationId, `${context} activation id`);
    checkedU32(record.ownerId, `${context} owner id`);
    if (record.kind === ForkModuleStateRecordKind.ReferenceRecipeSegment) {
      if (record.activationId !== 0 || record.ownerId !== 1) {
        throw new Error(
          `${context}: reference-recipe segments must use process ownership`,
        );
      }
      if (referenceRecipeSeen) {
        throw new Error(
          `${context}: reference-recipe segment follows its final manifest`,
        );
      }
      referenceRecipeSegments++;
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.ReplayEventSegment) {
      if (
        record.activationId !== 0
        || record.ownerId !== WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER
      ) {
        throw new Error(
          `${context}: replay-event segments must use process ownership`,
        );
      }
      if (replayEventsSeen) {
        throw new Error(
          `${context}: replay-event segment follows its final manifest`,
        );
      }
      replayEventSegments++;
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.ReplayEvents) {
      if (
        record.activationId !== 0
        || record.ownerId !== WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER
      ) {
        throw new Error(`${context}: replay events must use process ownership`);
      }
      if (replayEventsSeen) {
        throw new Error(`${context}: duplicate process replay-event record`);
      }
      replayEventManifest = record.payload;
      replayEventsSeen = true;
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.ImportedGlobalBindings) {
      if (
        record.activationId !== 0
        || record.ownerId !== WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER
      ) {
        throw new Error(
          `${context}: imported-global bindings must use process ownership`,
        );
      }
      if (importedGlobalBindingsSeen) {
        throw new Error(`${context}: duplicate imported-global binding record`);
      }
      decodeForkImportedGlobalBindings(record.payload, context);
      importedGlobalBindingsSeen = true;
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.ImportedTableBindings) {
      if (
        record.activationId !== 0
        || record.ownerId !== WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER
      ) {
        throw new Error(
          `${context}: imported-table bindings must use process ownership`,
        );
      }
      if (importedTableBindingsSeen) {
        throw new Error(`${context}: duplicate imported-table binding record`);
      }
      decodeForkImportedTableBindings(record.payload, context);
      importedTableBindingsSeen = true;
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.ActivationContinuations) {
      if (
        record.activationId !== 0
        || record.ownerId !== WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER
      ) {
        throw new Error(
          `${context}: activation continuations must use process ownership`,
        );
      }
      if (activationContinuations) {
        throw new Error(`${context}: duplicate activation-continuation record`);
      }
      activationContinuations = decodeForkActivationContinuations(
        record.payload,
        context,
      );
      if (ptrWidth === 4) {
        for (const continuation of activationContinuations) {
          if (continuation.root > 0xffff_ffffn) {
            throw new RangeError(
              `${context}: activation ${continuation.activationId} root does not fit wasm32`,
            );
          }
        }
      }
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.JournalImage) {
      if (
        record.activationId !== 0
        || record.ownerId !== WPK_FORK_JOURNAL_IMAGE_OWNER
      ) {
        throw new Error(
          `${context}: journal image must use process ownership`,
        );
      }
      if (journalImageSeen) {
        throw new Error(`${context}: duplicate journal-image record`);
      }
      const image = decodeForkJournalImage(record.payload, context);
      if (ptrWidth === 4 && (image.ptr > 0xffff_ffffn || image.len > 0xffff_ffffn)) {
        throw new RangeError(`${context}: journal image does not fit wasm32`);
      }
      journalImageSeen = true;
      continue;
    }
    if (record.kind === ForkModuleStateRecordKind.Module) {
      if (record.ownerId !== 0) {
        throw new Error(`${context}: module record must use owner id zero`);
      }
      if (modules.has(record.activationId)) {
        throw new Error(`${context}: duplicate module activation ${record.activationId}`);
      }
      decodeModulePayload(record.payload, context);
      modules.add(record.activationId);
      continue;
    }

    if (!modules.has(record.activationId)) {
      throw new Error(
        `${context}: state refers to undeclared module activation ${record.activationId}`,
      );
    }
    if (record.ownerId === 0) {
      throw new Error(`${context}: state record has no explicit owner`);
    }

    if (record.kind === ForkModuleStateRecordKind.TablePage) {
      const key = tableKey(record.activationId, record.ownerId);
      const table = tables.get(key);
      if (!table) {
        throw new Error(`${context}: table page precedes its owning table descriptor`);
      }
      const page = validateTablePage(record, table, context);
      const previous = lastTablePages.get(key);
      if (previous !== undefined && page.pageIndex <= previous) {
        throw new Error(`${context}: table pages are not strictly increasing`);
      }
      lastTablePages.set(key, page.pageIndex);
      tablePageCounts.set(key, (tablePageCounts.get(key) ?? 0) + 1);
      continue;
    }

    const key = ownerKey(record.kind, record.activationId, record.ownerId);
    if (owned.has(key)) {
      throw new Error(
        `${context}: duplicate owner ${record.ownerId} for record kind ${record.kind}`,
      );
    }
    owned.add(key);

    if (record.kind === ForkModuleStateRecordKind.ReferenceRecipe) {
      referenceRecipeSeen = true;
    }

    if (record.kind === ForkModuleStateRecordKind.Table) {
      const table = decodeTableDescriptor(record, context);
      const tableIdentity = tableKey(record.activationId, record.ownerId);
      if (tables.has(tableIdentity)) {
        throw new Error(`${context}: duplicate table owner ${tableIdentity}`);
      }
      tables.set(tableIdentity, table);
      tablePageCounts.set(tableIdentity, 0);
    } else if (record.kind === ForkModuleStateRecordKind.MutableGlobal) {
      decodeForkGlobalSnapshot(record.payload, context);
    } else if (record.kind === ForkModuleStateRecordKind.ElementSegments) {
      decodeElementSegments(record.payload, context);
    } else if (record.kind === ForkModuleStateRecordKind.DataSegments) {
      decodeDataSegments(record.payload, context);
    }
  }

  if (referenceRecipeSegments !== 0 && !referenceRecipeSeen) {
    throw new Error(
      `module-state has ${referenceRecipeSegments} reference-recipe segment(s) `
      + "without a final manifest",
    );
  }
  if (replayEventSegments !== 0 && !replayEventsSeen) {
    throw new Error(
      `module-state has ${replayEventSegments} replay-event segment(s) `
      + "without a final manifest",
    );
  }
  const replayActivationIds = replayEventManifest
    ? validateForkReplayEventWire({
        manifest: replayEventManifest,
        segments: {
          *[Symbol.iterator]() {
            for (const record of records) {
              if (record.kind === ForkModuleStateRecordKind.ReplayEventSegment) {
                yield record.payload;
              }
            }
          },
        },
      }).activationIds
    : null;

  for (const [key, table] of tables) {
    const actual = tablePageCounts.get(key) ?? 0;
    if (actual !== table.pageCount) {
      throw new Error(
        `module-state table ${key} declares ${table.pageCount} sparse pages, found ${actual}`,
      );
    }
  }
  if (modules.size === 0) {
    throw new Error("module-state arena has no declared module activation");
  }
  if (activationContinuations) {
    // The JS continuation manifest is cross-checked against the process
    // replay-event wire (both live in this arena, and the manifest names exactly
    // the ACTIVE activations the events cover). A Phase 6 D7a.1a module-backed
    // multi-activation fork instead owns its journal inside the co-resident
    // module's serialized image (not this arena), so it writes NO replay-event
    // records; its manifest names EVERY registered activation. When the arena has
    // no replay-event manifest, cross-check the continuation set against the
    // module-descriptor set — the authoritative activation set on the module path
    // — so the manifest is still validated exactly, never silently accepted.
    assertActivationContinuationSet(
      activationContinuations,
      replayActivationIds ?? modules,
      "module-state activation continuations",
    );
    for (const { activationId } of activationContinuations) {
      if (!modules.has(activationId)) {
        throw new Error(
          `module-state activation continuation ${activationId} has no module descriptor`,
        );
      }
    }
  }
}

function decodeSparseTables(
  records: readonly ForkModuleStateRecord[],
): DecodedForkSparseTableSnapshot[] {
  validateRecordOwnership(records);
  const tables = new Map<string, DecodedForkSparseTableSnapshot>();
  for (const [recordIndex, record] of records.entries()) {
    if (record.kind === ForkModuleStateRecordKind.Table) {
      const descriptor = decodeTableDescriptor(
        record,
        `module-state record ${recordIndex}`,
      );
      tables.set(tableKey(record.activationId, record.ownerId), {
        activationId: descriptor.activationId,
        ownerId: descriptor.ownerId,
        indexWidth: descriptor.indexWidth,
        pageShift: descriptor.pageShift,
        length: descriptor.length,
        baselineLength: descriptor.baselineLength,
        baselineFingerprint: descriptor.baselineFingerprint,
        pages: [],
      });
    } else if (record.kind === ForkModuleStateRecordKind.TablePage) {
      const table = tables.get(tableKey(record.activationId, record.ownerId));
      if (!table) {
        throw new Error(`module-state record ${recordIndex}: missing table descriptor`);
      }
      const descriptor: DecodedTableDescriptor = {
        ...table,
        flags: TABLE_FLAG_SPARSE_OVERRIDES,
        pageCount: 0,
      };
      const page = decodeTablePage(
        record,
        descriptor,
        `module-state record ${recordIndex}`,
      );
      table.pages.push({ pageIndex: page.pageIndex, runs: page.runs });
    }
  }
  return Array.from(tables.values());
}

/**
 * Owner for one activation's versioned module-state recipe arena.
 *
 * The arena contains bytes only. Any temporary JS reference-to-recipe maps
 * belong to the future coordinator and must be cleared before calling
 * `release`; this class never turns such references into hidden GC roots.
 */
export class ForkModuleStateArena {
  private root = 0;
  private tail = 0;
  private chunks: ArenaChunk[] = [];
  private sealed = false;
  private ownership: "owned" | "borrowed" | null = null;
  private pending: PendingRecord | null = null;
  private readonly payloadIndex = new Map<string, number[]>();

  constructor(
    private readonly memory: WebAssembly.Memory,
    readonly ptrWidth: 4 | 8,
    private readonly allocate: ContinuationAllocate,
    private readonly deallocate: ContinuationDeallocate,
    private readonly label: string,
  ) {
    if (ptrWidth !== 4 && ptrWidth !== 8) {
      throw new RangeError(`${label}: unsupported module-state pointer width ${ptrWidth}`);
    }
  }

  begin(): number {
    if (this.root !== 0) {
      throw new Error(`${this.label}: module-state arena is already active`);
    }
    const root = this.allocateChunk(WASM_PAGE_SIZE, 0, true);
    this.root = root;
    this.tail = root;
    this.ownership = "owned";
    return root;
  }

  attach(root: number | bigint): void {
    this.attachWithOwnership(root, "owned");
  }

  /**
   * Validate a sealed arena while retaining ownership in another process.
   *
   * A vfork child reads the parent's module recipes from shared Memory. It
   * must detach its JavaScript indexes after replay, never munmap the parent's
   * arena mappings.
   */
  attachBorrowed(root: number | bigint): void {
    this.attachWithOwnership(root, "borrowed");
  }

  private attachWithOwnership(
    root: number | bigint,
    ownership: "owned" | "borrowed",
  ): void {
    if (this.root !== 0) {
      throw new Error(`${this.label}: module-state arena is already active`);
    }
    const rootNumber = checkedPointer(
      root,
      this.ptrWidth,
      `${this.label}: module-state root`,
      false,
    );
    if (rootNumber % WASM_PAGE_SIZE !== 0) {
      throw new Error(`${this.label}: module-state root is not page-aligned`);
    }
    const chunks = this.validateChunks(rootNumber, true);
    const records = this.decodeRecords(chunks, false);
    validateRecordOwnership(records, this.ptrWidth);
    const payloadIndex = this.buildPayloadIndex(chunks);
    // Publish ownership only after the complete guest-controlled arena passes
    // structural and semantic validation. Failed attachment must not release
    // mappings that this host never safely adopted.
    this.root = rootNumber;
    this.tail = chunks[chunks.length - 1]!.addr;
    this.chunks = chunks;
    this.payloadIndex.clear();
    for (const [key, addresses] of payloadIndex) {
      this.payloadIndex.set(key, addresses);
    }
    this.sealed = true;
    this.ownership = ownership;
  }

  /**
   * Copy one exact record from a sealed, guest-owned arena without adopting
   * or copying every other payload.
   *
   * This validates the chunk chain and every record envelope, but deliberately
   * leaves record-kind semantics to the selected payload's decoder. It exists
   * for pre-launch owners such as the externref broker: a large dirty table
   * must not be copied into JavaScript merely to inspect the small KFRV graph.
   */
  inspectSealedRecordPayload(
    root: number | bigint,
    kind: ForkModuleStateRecordKind,
    activationId: number,
    ownerId: number,
  ): Uint8Array {
    const matches = this.inspectSealedRecordViews(
      root,
      [kind],
      activationId,
      ownerId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${this.label}: ${matches.length === 0 ? "missing" : "duplicate"} `
        + `module-state record ${kind}:${activationId}:${ownerId}`,
      );
    }
    return matches[0]!.payload.slice();
  }

  /**
   * Validate a sealed arena and expose selected payloads as zero-copy views.
   *
   * WHY: process owners must sometimes inspect a segmented reference/event
   * stream before the child Worker exists. Copying every selected segment (or
   * unrelated table page) would recreate a whole-transaction allocation
   * boundary. Returned views remain valid only while `memory` and the sealed
   * arena mappings remain alive.
   */
  inspectSealedRecordViews(
    root: number | bigint,
    kinds: readonly ForkModuleStateRecordKind[],
    activationId?: number,
    ownerId?: number,
  ): readonly ForkModuleStateRecordView[] {
    if (this.root !== 0) {
      throw new Error(
        `${this.label}: cannot inspect while the arena owns another root`,
      );
    }
    if (kinds.length === 0) {
      throw new RangeError(`${this.label}: no module-state record kinds selected`);
    }
    const selectedKinds = new Set<number>();
    for (const kind of kinds) {
      if (!RECORD_KINDS.has(kind)) {
        throw new RangeError(`${this.label}: unknown module-state record kind ${kind}`);
      }
      selectedKinds.add(kind);
    }
    if ((activationId === undefined) !== (ownerId === undefined)) {
      throw new Error(
        `${this.label}: record activation and owner filters must be paired`,
      );
    }
    if (activationId !== undefined && ownerId !== undefined) {
      checkedU32(activationId, `${this.label}: record activation id`);
      checkedU32(ownerId, `${this.label}: record owner id`);
    }
    const rootNumber = checkedPointer(
      root,
      this.ptrWidth,
      `${this.label}: module-state root`,
      false,
    );
    if (rootNumber % WASM_PAGE_SIZE !== 0) {
      throw new Error(`${this.label}: module-state root is not page-aligned`);
    }

    const chunks = this.validateChunks(rootNumber, true);
    return Object.freeze(
      this.decodeRecords(chunks, false).filter((record) =>
        selectedKinds.has(record.kind)
        && (
          activationId === undefined
          || (
            record.activationId === activationId
            && record.ownerId === ownerId
          )
        )
      ),
    );
  }

  appendModule(record: ForkModuleDescriptorRecord): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.Module,
      activationId: record.activationId,
      ownerId: 0,
      payload: encodeModulePayload(record),
    });
  }

  appendElementSegmentState(state: ForkElementSegmentState): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.ElementSegments,
      activationId: state.activationId,
      ownerId: state.ownerId,
      payload: encodeElementSegments(state),
    });
  }

  appendDataSegmentState(state: ForkDataSegmentState): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.DataSegments,
      activationId: state.activationId,
      ownerId: state.ownerId,
      payload: encodeDataSegments(state),
    });
  }

  appendImportedGlobalBindings(
    bindings: readonly ForkImportedGlobalBinding[],
  ): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.ImportedGlobalBindings,
      activationId: 0,
      ownerId: WPK_FORK_IMPORTED_GLOBAL_BINDINGS_OWNER,
      payload: encodeForkImportedGlobalBindings(bindings),
    });
  }

  appendImportedTableBindings(
    bindings: readonly ForkImportedTableBinding[],
  ): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.ImportedTableBindings,
      activationId: 0,
      ownerId: WPK_FORK_IMPORTED_TABLE_BINDINGS_OWNER,
      payload: encodeForkImportedTableBindings(bindings),
    });
  }

  appendSparseTable(snapshot: ForkSparseTableSnapshot): void {
    checkedU32(snapshot.activationId, "table activation id");
    checkedU32(snapshot.ownerId, "table owner id", false);
    const descriptorPayload = encodeTableDescriptor(snapshot);
    const descriptor = decodeTableDescriptor({
      kind: ForkModuleStateRecordKind.Table,
      activationId: snapshot.activationId,
      ownerId: snapshot.ownerId,
      payload: descriptorPayload,
    }, "table snapshot");
    // Validate the complete logical snapshot before publishing its descriptor.
    // This pass allocates no page payloads, so table size does not become a
    // second whole-transaction memory requirement in the host.
    let previousPageIndex: bigint | null = null;
    for (const page of snapshot.pages) {
      previousPageIndex = validateSparseTablePage(
        descriptor,
        page,
        previousPageIndex,
      ).pageIndex;
    }

    this.appendRecord({
      kind: ForkModuleStateRecordKind.Table,
      activationId: snapshot.activationId,
      ownerId: snapshot.ownerId,
      payload: descriptorPayload,
    });
    previousPageIndex = null;
    for (const page of snapshot.pages) {
      const payload = encodeTablePage(descriptor, page, previousPageIndex);
      this.appendRecord({
        kind: ForkModuleStateRecordKind.TablePage,
        activationId: snapshot.activationId,
        ownerId: snapshot.ownerId,
        payload,
      });
      previousPageIndex = checkedU64(page.pageIndex, "table page index");
    }
  }

  appendRecord(record: ForkModuleStateRecord): void {
    if (!(record.payload instanceof Uint8Array)) {
      throw new TypeError(`${this.label}: module-state record payload must be Uint8Array`);
    }
    const payloadAddr = this.reserveRecord(
      record.kind,
      record.activationId,
      record.ownerId,
      record.payload.byteLength,
    );
    const payloadNumber = checkedPointer(
      payloadAddr,
      this.ptrWidth,
      `${this.label}: reserved module-state payload`,
      false,
    );
    new Uint8Array(
      this.memory.buffer,
      payloadNumber,
      record.payload.byteLength,
    ).set(record.payload);
    this.commitRecord(payloadAddr);
  }

  appendReplayEvents(source: ForkReplayEventCaptureSource): void {
    // WHY: segments are committed before the small final manifest. The
    // manifest is the transaction marker, so a failed page allocation cannot
    // make a truncated journal appear complete in a copied child arena.
    for (const payload of source.capturedSegmentPayloads()) {
      this.appendRecord({
        kind: ForkModuleStateRecordKind.ReplayEventSegment,
        activationId: 0,
        ownerId: WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER,
        payload,
      });
    }
    this.appendRecord({
      kind: ForkModuleStateRecordKind.ReplayEvents,
      activationId: 0,
      ownerId: WPK_FORK_MODULE_STATE_REPLAY_EVENTS_OWNER,
      payload: source.capturedManifestPayload(),
    });
  }

  appendActivationContinuations(
    continuations: readonly ForkActivationContinuation[],
  ): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.ActivationContinuations,
      activationId: 0,
      ownerId: WPK_FORK_ACTIVATION_CONTINUATIONS_OWNER,
      payload: encodeForkActivationContinuations(continuations),
    });
  }

  /**
   * Append the `JournalImage` manifest (Option B): where the parent
   * channel-mmap'd the serialized KFRE journal image and its length. The child
   * reads it (`journalImageForChild`) to find and decode the inherited image.
   */
  appendJournalImage(image: ForkJournalImage): void {
    this.appendRecord({
      kind: ForkModuleStateRecordKind.JournalImage,
      activationId: 0,
      ownerId: WPK_FORK_JOURNAL_IMAGE_OWNER,
      payload: encodeForkJournalImage(image),
    });
  }

  /**
   * Reserve one record payload for an instrumented Wasm snapshot helper.
   *
   * The record is not reachable through a chunk's committed `used` boundary
   * until `commitRecord` succeeds. A trap or encoding failure can therefore
   * release the whole arena without publishing partial recipe bytes.
   */
  reserveRecord(
    kind: number,
    activationId: number,
    ownerId: number,
    payloadSize: number | bigint,
  ): number | bigint {
    this.requireWritable();
    if (this.pending) {
      throw new Error(`${this.label}: a module-state record reservation is already pending`);
    }
    if (!RECORD_KINDS.has(kind)) {
      throw new RangeError(`${this.label}: unknown module-state record kind ${kind}`);
    }
    checkedU32(activationId, `${this.label}: record activation id`);
    checkedU32(ownerId, `${this.label}: record owner id`);
    const payloadBytes = checkedPointer(
      payloadSize,
      this.ptrWidth,
      `${this.label}: module-state payload size`,
      true,
    );
    const totalSize = alignUp(
      RECORD_HEADER_SIZE + payloadBytes,
      FORK_MODULE_STATE_RECORD_ALIGNMENT,
    );
    if (totalSize > 0xffff_ffff) {
      throw new RangeError(`${this.label}: module-state record exceeds u32 size`);
    }
    let chunk = this.chunks[this.chunks.length - 1]!;
    if (totalSize > chunk.size - chunk.used) {
      const capacity = alignUp(
        Math.max(WASM_PAGE_SIZE, chunkHeaderSize(this.ptrWidth) + totalSize),
        WASM_PAGE_SIZE,
      );
      const next = this.allocateChunk(capacity, this.tail, false);
      writePointer(
        this.memory,
        this.ptrWidth,
        this.tail + chunkOffset(this.ptrWidth, 2),
        next,
      );
      this.tail = next;
      chunk = this.chunks[this.chunks.length - 1]!;
    }
    const recordAddr = chunk.addr + chunk.used;
    checkedMemoryRange(
      this.memory,
      recordAddr,
      totalSize,
      `${this.label}: module-state record`,
    );
    const view = new DataView(this.memory.buffer);
    view.setUint32(recordAddr, RECORD_MAGIC, true);
    view.setUint16(recordAddr + 4, FORK_MODULE_STATE_RECORD_VERSION, true);
    view.setUint16(recordAddr + 6, kind, true);
    view.setUint32(recordAddr + 8, totalSize, true);
    view.setUint32(recordAddr + 12, payloadBytes, true);
    view.setUint32(recordAddr + 16, activationId, true);
    view.setUint32(recordAddr + 20, ownerId, true);
    new Uint8Array(
      this.memory.buffer,
      recordAddr + RECORD_HEADER_SIZE,
      totalSize - RECORD_HEADER_SIZE,
    ).fill(0);
    const payloadAddr = recordAddr + RECORD_HEADER_SIZE;
    this.pending = {
      chunk,
      kind: kind as ForkModuleStateRecordKind,
      activationId,
      ownerId,
      payloadAddr,
      totalSize,
      payloadSize: payloadBytes,
    };
    return this.ptrWidth === 8 ? BigInt(payloadAddr) : payloadAddr;
  }

  commitRecord(payloadAddr: number | bigint): void {
    this.requireWritable();
    const payloadNumber = checkedPointer(
      payloadAddr,
      this.ptrWidth,
      `${this.label}: module-state payload commit`,
      false,
    );
    const pending = this.pending;
    if (!pending || pending.payloadAddr !== payloadNumber) {
      throw new Error(`${this.label}: module-state commit does not match reservation`);
    }
    const chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk !== pending.chunk) {
      throw new Error(`${this.label}: pending module-state record is not in the active chunk`);
    }
    // Publish used/count only after the complete record and zero padding are
    // visible. A sealed root can therefore never expose a partial TLV.
    const paddingSize = pending.totalSize - RECORD_HEADER_SIZE - pending.payloadSize;
    requireZeroBytes(
      new Uint8Array(
        this.memory.buffer,
        pending.payloadAddr + pending.payloadSize,
        paddingSize,
      ),
      `${this.label}: pending module-state record`,
    );
    chunk.used += pending.totalSize;
    chunk.recordCount++;
    writePointer(
      this.memory,
      this.ptrWidth,
      chunk.addr + chunkOffset(this.ptrWidth, 4),
      chunk.used,
    );
    new DataView(this.memory.buffer).setUint32(
      chunk.addr + chunkRecordCountOffset(this.ptrWidth),
      chunk.recordCount,
      true,
    );
    const key = ownerKey(
      pending.kind,
      pending.activationId,
      pending.ownerId,
    );
    const addresses = this.payloadIndex.get(key) ?? [];
    addresses.push(pending.payloadAddr);
    this.payloadIndex.set(key, addresses);
    this.pending = null;
  }

  /**
   * Resolve one committed record without copying its payload.
   *
   * The generated restore helper addresses table pages by ordinal, so keeping
   * this index linearizes attachment once and makes large-table replay O(n)
   * instead of rescanning the arena for every page.
   */
  findRecord(
    kind: number,
    activationId: number,
    ownerId: number,
    ordinal: number,
  ): number | bigint {
    if (!this.sealed || this.root === 0) {
      throw new Error(`${this.label}: cannot find a record in an unsealed arena`);
    }
    if (!RECORD_KINDS.has(kind)) {
      throw new RangeError(`${this.label}: unknown module-state record kind ${kind}`);
    }
    checkedU32(activationId, `${this.label}: record activation id`);
    checkedU32(ownerId, `${this.label}: record owner id`);
    checkedU32(ordinal, `${this.label}: record ordinal`);
    const addresses = this.payloadIndex.get(ownerKey(
      kind as ForkModuleStateRecordKind,
      activationId,
      ownerId,
    ));
    const payload = addresses?.[ordinal];
    if (payload === undefined) {
      throw new Error(
        `${this.label}: missing module-state record `
        + `${kind}:${activationId}:${ownerId}:${ordinal}`,
      );
    }
    return this.ptrWidth === 8 ? BigInt(payload) : payload;
  }

  seal(): number {
    this.requireWritable();
    if (this.pending) {
      throw new Error(`${this.label}: cannot seal with a pending module-state record`);
    }
    const validatedChunks = this.validateChunks(this.root, false);
    if (
      validatedChunks.length !== this.chunks.length
      || validatedChunks.some((chunk, index) => (
        chunk.addr !== this.chunks[index]!.addr
        || chunk.size !== this.chunks[index]!.size
      ))
    ) {
      throw new Error(`${this.label}: module-state chunk ownership changed before seal`);
    }
    const records = this.decodeRecords(validatedChunks, false);
    validateRecordOwnership(records, this.ptrWidth);
    for (let index = this.chunks.length - 1; index >= 1; index--) {
      this.writeChunkFlags(this.chunks[index]!.addr, CHUNK_FLAG_SEALED);
    }
    // Root is the commit point. Child attachment refuses an arena unless this
    // flag is present, so it cannot race a partially populated tail.
    this.writeChunkFlags(this.root, CHUNK_FLAG_ROOT | CHUNK_FLAG_SEALED);
    this.sealed = true;
    return this.root;
  }

  records(): ForkModuleStateRecord[] {
    if (!this.sealed || this.root === 0) {
      throw new Error(`${this.label}: module-state arena is not sealed`);
    }
    return this.decodeRecords(this.chunks);
  }

  /**
   * Zero-copy counterpart to `records()` for bounded streaming decoders.
   *
   * Callers must finish using these views before `release()` recycles the arena
   * mappings. The returned record envelopes and underlying sealed bytes are
   * immutable by contract.
   */
  recordViews(): readonly ForkModuleStateRecordView[] {
    if (!this.sealed || this.root === 0) {
      throw new Error(`${this.label}: module-state arena is not sealed`);
    }
    return Object.freeze(this.decodeRecords(this.chunks, false));
  }

  /**
   * Inspect committed records while the parent transaction is still writable.
   *
   * Process-owned manifests such as imported-global provenance are derived
   * from module-owned records and must themselves be appended before `seal`.
   * Pending reservations are excluded so callers never derive state from
   * bytes that Wasm has not committed.
   */
  recordsForCapture(): ForkModuleStateRecord[] {
    this.requireWritable();
    if (this.pending) {
      throw new Error(
        `${this.label}: cannot inspect module state with a pending record`,
      );
    }
    const chunks = this.validateChunks(this.root, false);
    const records = this.decodeRecords(chunks);
    validateRecordOwnership(records, this.ptrWidth);
    return records;
  }

  sparseTables(): DecodedForkSparseTableSnapshot[] {
    return decodeSparseTables(this.records());
  }

  rootAddress(): number {
    if (this.root === 0) {
      throw new Error(`${this.label}: no active module-state arena`);
    }
    return this.root;
  }

  hasActiveArena(): boolean {
    return this.root !== 0;
  }

  isSealed(): boolean {
    return this.sealed;
  }

  ownershipMode(): "owned" | "borrowed" | null {
    return this.ownership;
  }

  release(): void {
    if (this.root === 0) {
      throw new Error(`${this.label}: no active module-state arena to release`);
    }
    if (this.ownership !== "owned") {
      throw new Error(`${this.label}: borrowed module-state arena cannot be released`);
    }
    const chunks = this.chunks.splice(0).reverse();
    this.clearControllerState();
    let firstError: unknown;
    for (const chunk of chunks) {
      try {
        this.deallocate(chunk.addr, chunk.size);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Drop borrowed indexes without deallocating their parent's mappings. */
  detachBorrowed(): void {
    if (this.root === 0 || this.ownership !== "borrowed") {
      throw new Error(`${this.label}: no borrowed module-state arena to detach`);
    }
    this.chunks = [];
    this.clearControllerState();
  }

  private clearControllerState(): void {
    this.pending = null;
    this.payloadIndex.clear();
    this.root = 0;
    this.tail = 0;
    this.sealed = false;
    this.ownership = null;
  }

  private requireWritable(): void {
    if (this.root === 0) {
      throw new Error(`${this.label}: module-state arena has not begun`);
    }
    if (this.sealed) {
      throw new Error(`${this.label}: module-state arena is sealed`);
    }
  }

  private allocateChunk(capacity: number, previous: number, root: boolean): number {
    let addr: number;
    try {
      addr = this.allocate(capacity);
    } catch (error) {
      if (error instanceof ContinuationAllocationError) throw error;
      throw new Error(
        `${this.label}: module-state allocation of ${capacity} bytes failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const valid = Number.isSafeInteger(addr)
      && addr > 0
      && addr % WASM_PAGE_SIZE === 0
      && capacity >= WASM_PAGE_SIZE
      && capacity % WASM_PAGE_SIZE === 0
      && checkedEnd(addr, capacity, `${this.label}: module-state allocation`)
        <= this.memory.buffer.byteLength
      && (this.ptrWidth === 8 || addr + capacity <= 0x1_0000_0000);
    if (!valid) {
      if (Number.isSafeInteger(addr) && addr > 0) {
        try {
          this.deallocate(addr, capacity);
        } catch {
          // Preserve the allocator contract failure.
        }
      }
      throw new Error(`${this.label}: allocator returned an invalid module-state chunk`);
    }
    const headerSize = chunkHeaderSize(this.ptrWidth);
    const view = new DataView(this.memory.buffer);
    view.setUint32(addr, CHUNK_MAGIC, true);
    view.setUint16(addr + 4, FORK_MODULE_STATE_ARENA_VERSION, true);
    view.setUint16(addr + 6, root ? CHUNK_FLAG_ROOT : 0, true);
    writePointer(this.memory, this.ptrWidth, addr + chunkOffset(this.ptrWidth, 0), root ? addr : this.root);
    writePointer(this.memory, this.ptrWidth, addr + chunkOffset(this.ptrWidth, 1), previous);
    writePointer(this.memory, this.ptrWidth, addr + chunkOffset(this.ptrWidth, 2), 0);
    writePointer(this.memory, this.ptrWidth, addr + chunkOffset(this.ptrWidth, 3), capacity);
    writePointer(this.memory, this.ptrWidth, addr + chunkOffset(this.ptrWidth, 4), headerSize);
    new DataView(this.memory.buffer).setUint32(
      addr + chunkRecordCountOffset(this.ptrWidth),
      0,
      true,
    );
    new DataView(this.memory.buffer).setUint32(
      addr + chunkReservedOffset(this.ptrWidth),
      0,
      true,
    );
    const fieldsEnd = chunkReservedOffset(this.ptrWidth) + 4;
    new Uint8Array(this.memory.buffer, fieldsEnd, headerSize - fieldsEnd).fill(0);
    this.chunks.push({
      addr,
      size: capacity,
      used: headerSize,
      recordCount: 0,
    });
    return addr;
  }

  private writeChunkFlags(addr: number, flags: number): void {
    new DataView(this.memory.buffer).setUint16(addr + 6, flags, true);
  }

  private validateChunks(root: number, requireSealed: boolean): ArenaChunk[] {
    const chunks: ArenaChunk[] = [];
    const seen = new Set<number>();
    const maxChunks = Math.floor(this.memory.buffer.byteLength / WASM_PAGE_SIZE);
    let current = root;
    let previous = 0;
    for (;;) {
      if (seen.has(current)) {
        throw new Error(`${this.label}: module-state chunk cycle`);
      }
      if (seen.size >= maxChunks) {
        throw new Error(`${this.label}: module-state chunk chain exceeds memory`);
      }
      seen.add(current);
      const chunk = this.validateChunk(
        current,
        root,
        previous,
        chunks.length === 0,
        requireSealed,
      );
      chunks.push(chunk);
      const next = readPointer(
        this.memory,
        this.ptrWidth,
        current + chunkOffset(this.ptrWidth, 2),
        `${this.label}: module-state next chunk`,
      );
      if (next === 0) break;
      previous = current;
      current = next;
    }

    const sorted = [...chunks].sort((left, right) => left.addr - right.addr);
    for (let index = 1; index < sorted.length; index++) {
      const prior = sorted[index - 1]!;
      const currentChunk = sorted[index]!;
      if (
        checkedEnd(prior.addr, prior.size, `${this.label}: module-state chunk`)
        > currentChunk.addr
      ) {
        throw new Error(`${this.label}: module-state chunk ranges overlap`);
      }
    }
    return chunks;
  }

  private validateChunk(
    addr: number,
    root: number,
    previous: number,
    isRoot: boolean,
    requireSealed: boolean,
  ): ArenaChunk {
    const headerSize = chunkHeaderSize(this.ptrWidth);
    if (
      !Number.isSafeInteger(addr)
      || addr <= 0
      || addr % WASM_PAGE_SIZE !== 0
      || checkedEnd(addr, headerSize, `${this.label}: module-state chunk header`)
        > this.memory.buffer.byteLength
    ) {
      throw new Error(`${this.label}: invalid module-state chunk address`);
    }
    const view = new DataView(this.memory.buffer);
    const expectedFlags = (requireSealed ? CHUNK_FLAG_SEALED : 0)
      | (isRoot ? CHUNK_FLAG_ROOT : 0);
    if (
      view.getUint32(addr, true) !== CHUNK_MAGIC
      || view.getUint16(addr + 4, true) !== FORK_MODULE_STATE_ARENA_VERSION
      || view.getUint16(addr + 6, true) !== expectedFlags
      || readPointer(
        this.memory,
        this.ptrWidth,
        addr + chunkOffset(this.ptrWidth, 0),
        `${this.label}: module-state chunk root`,
      ) !== root
      || readPointer(
        this.memory,
        this.ptrWidth,
        addr + chunkOffset(this.ptrWidth, 1),
        `${this.label}: module-state previous chunk`,
      ) !== previous
    ) {
      throw new Error(`${this.label}: invalid or unsealed module-state chunk`);
    }
    const capacity = readPointer(
      this.memory,
      this.ptrWidth,
      addr + chunkOffset(this.ptrWidth, 3),
      `${this.label}: module-state chunk capacity`,
    );
    const used = readPointer(
      this.memory,
      this.ptrWidth,
      addr + chunkOffset(this.ptrWidth, 4),
      `${this.label}: module-state chunk used bytes`,
    );
    const recordCount = view.getUint32(
      addr + chunkRecordCountOffset(this.ptrWidth),
      true,
    );
    if (
      capacity < WASM_PAGE_SIZE
      || capacity % WASM_PAGE_SIZE !== 0
      || checkedEnd(addr, capacity, `${this.label}: module-state chunk bounds`)
        > this.memory.buffer.byteLength
      || used < headerSize
      || used > capacity
      || (!isRoot && (used === headerSize || recordCount === 0))
      || view.getUint32(addr + chunkReservedOffset(this.ptrWidth), true) !== 0
    ) {
      throw new Error(`${this.label}: invalid module-state chunk bounds or metadata`);
    }
    const fieldsEnd = chunkReservedOffset(this.ptrWidth) + 4;
    requireZeroBytes(
      new Uint8Array(this.memory.buffer, addr + fieldsEnd, headerSize - fieldsEnd),
      `${this.label}: module-state chunk header`,
    );
    return { addr, size: capacity, used, recordCount };
  }

  private decodeRecords(
    chunks: readonly ArenaChunk[],
    copyPayload = true,
  ): ForkModuleStateRecord[] {
    const records: ForkModuleStateRecord[] = [];
    for (const [chunkIndex, chunk] of chunks.entries()) {
      let offset = chunkHeaderSize(this.ptrWidth);
      let recordCount = 0;
      while (offset < chunk.used) {
        const addr = chunk.addr + offset;
        if (offset + RECORD_HEADER_SIZE > chunk.used) {
          throw new Error(
            `${this.label}: module-state chunk ${chunkIndex} has a truncated record header`,
          );
        }
        const view = new DataView(this.memory.buffer);
        const kind = view.getUint16(addr + 6, true);
        if (
          view.getUint32(addr, true) !== RECORD_MAGIC
          || view.getUint16(addr + 4, true) !== FORK_MODULE_STATE_RECORD_VERSION
          || !RECORD_KINDS.has(kind)
        ) {
          throw new Error(
            `${this.label}: module-state chunk ${chunkIndex} has an invalid record header`,
          );
        }
        const totalSize = view.getUint32(addr + 8, true);
        const payloadSize = view.getUint32(addr + 12, true);
        const expectedTotal = alignUp(
          RECORD_HEADER_SIZE + payloadSize,
          FORK_MODULE_STATE_RECORD_ALIGNMENT,
        );
        if (
          totalSize !== expectedTotal
          || totalSize < RECORD_HEADER_SIZE
          || offset + totalSize > chunk.used
        ) {
          throw new Error(
            `${this.label}: module-state chunk ${chunkIndex} has invalid record bounds`,
          );
        }
        const paddingSize = totalSize - RECORD_HEADER_SIZE - payloadSize;
        requireZeroBytes(
          new Uint8Array(
            this.memory.buffer,
            addr + RECORD_HEADER_SIZE + payloadSize,
            paddingSize,
          ),
          `${this.label}: module-state record ${records.length}`,
        );
        records.push({
          kind: kind as ForkModuleStateRecordKind,
          activationId: view.getUint32(addr + 16, true),
          ownerId: view.getUint32(addr + 20, true),
          payload: (() => {
            const payload = new Uint8Array(
            this.memory.buffer,
            addr + RECORD_HEADER_SIZE,
            payloadSize,
            );
            // `records()` preserves the historical detached-lifetime contract;
            // internal validation and streaming consumers opt into sealed
            // arena views explicitly.
            return copyPayload ? payload.slice() : payload;
          })(),
        });
        offset += totalSize;
        recordCount++;
      }
      if (offset !== chunk.used || recordCount !== chunk.recordCount) {
        throw new Error(
          `${this.label}: module-state chunk ${chunkIndex} record count is inconsistent`,
        );
      }
    }
    return records;
  }

  private buildPayloadIndex(
    chunks: readonly ArenaChunk[],
  ): Map<string, number[]> {
    const index = new Map<string, number[]>();
    for (const chunk of chunks) {
      let offset = chunkHeaderSize(this.ptrWidth);
      while (offset < chunk.used) {
        const addr = chunk.addr + offset;
        const view = new DataView(this.memory.buffer);
        const kind = view.getUint16(addr + 6, true) as ForkModuleStateRecordKind;
        const totalSize = view.getUint32(addr + 8, true);
        const activationId = view.getUint32(addr + 16, true);
        const ownerId = view.getUint32(addr + 20, true);
        const key = ownerKey(kind, activationId, ownerId);
        const addresses = index.get(key) ?? [];
        addresses.push(addr + RECORD_HEADER_SIZE);
        index.set(key, addresses);
        offset += totalSize;
      }
    }
    return index;
  }
}
