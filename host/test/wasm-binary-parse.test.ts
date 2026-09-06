/**
 * Unit tests for `extractHeapBase` and `extractAbiVersion` in
 * `host/src/constants.ts`. These parsers are on the host's hot path
 * for spawn/exec — every program load reads `__heap_base` to install
 * the kernel's initial brk before `_start` runs (see
 * `kernel_set_brk_base` in `crates/kernel/src/wasm_api.rs`).
 *
 * Tests construct minimal wasm binaries inline so they don't depend
 * on cached package binaries.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ABI_VERSION,
  WPK_CHECKPOINT_PROCESS_IMPORT,
  WPK_FORK_CAPABILITIES_SECTION,
  WPK_FORK_CAPABILITIES_VERSION,
  WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
  WPK_FORK_CAP_KNOWN_MASK,
  WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE,
  WPK_FORK_EXCEPTION_CODEC_SECTION,
  WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE,
  WPK_FORK_EXCEPTION_CODEC_VERSION,
  WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
  WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE,
  WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED,
  WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_MAGIC,
  WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_SECTION,
  WPK_FORK_IMPORTED_GLOBALS_VERSION,
  WPK_FORK_IMPORTED_TABLES_FLAG_TABLE64,
  WPK_FORK_IMPORTED_TABLES_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_MAGIC,
  WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_SECTION,
  WPK_FORK_IMPORTED_TABLES_VERSION,
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_POINTER_WIDTHS,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ARENA_VERSION,
  WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
  WPK_FORK_MODULE_STATE_FORMAT_SECTION,
  WPK_FORK_MODULE_STATE_FORMAT_VERSION,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
  WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT,
  WPK_FORK_MODULE_STATE_RECORD_VERSION,
  WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
  WPK_FORK_REQUIRED_EXPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_REQUIRED_TABLE_IMPORTS,
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
  WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE,
  WPK_FORK_STATIC_ROOT_CATALOG_MAGIC,
  WPK_FORK_STATIC_ROOT_CATALOG_SECTION,
  WPK_FORK_STATIC_ROOT_CATALOG_VERSION,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "../src/generated/abi";
import {
  describeWasmArtifactPolicyFailures,
  extractHeapBase,
  extractAbiVersion,
  extractThreadSlotDeclaration,
  wasmContainsLegacyAsyncify,
  wasmIsRelocatableObject,
  readWasmCustomSectionNames,
  readWasmExportNames,
  readWasmImportNames,
  wasmHasCompleteForkInstrumentation,
  wasmImportsKernelFork,
} from "../src/constants";
import {
  FORK_UNWIND_TAG_IMPORT_MODULE,
  FORK_UNWIND_TAG_IMPORT_NAME,
  FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
  FORK_UNWIND_TRANSPORT_SECTION,
  FORK_UNWIND_TRANSPORT_VERSION,
} from "../src/fork-unwind-transport";
import { tryResolveBinary } from "../src/binary-resolver";

// ---------------------------------------------------------------------------
// Minimal wasm-binary builder
// ---------------------------------------------------------------------------

function uleb128(n: number): number[] {
  const r: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    r.push(b);
  } while (n !== 0);
  return r;
}

function sleb128_i32(n: number): number[] {
  const r: number[] = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      r.push(b);
      return r;
    }
    r.push(b | 0x80);
  }
}

function sleb128_i64(n: bigint): number[] {
  const r: number[] = [];
  for (;;) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    const signBit = (b & 0x40) !== 0;
    if ((n === 0n && !signBit) || (n === -1n && signBit)) {
      r.push(b);
      return r;
    }
    r.push(b | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(s: string): number[] {
  const enc = new TextEncoder().encode(s);
  return [...uleb128(enc.length), ...enc];
}

interface GlobalImport {
  module: string;
  name: string;
  valType: number;
  mut: 0 | 1;
  shared?: boolean;
}
interface FuncImport { module: string; name: string; typeIdx: number; }
interface TableImport {
  module: string;
  name: string;
  elementType: number;
  table64: boolean;
  minimum: number;
  maximum: number | null;
}
type DefinedTable = Omit<TableImport, "module" | "name">;
interface TagImport { module: string; name: string; typeIdx: number; }
interface DefinedGlobal { valType: 0x7F | 0x7E; mut: 0 | 1; init: number[]; }
interface ExportEntry { name: string; kind: 0 | 1 | 2 | 3; index: number; }
interface FuncBody { locals: number[]; instructions: number[]; }

function buildWasm(opts: {
  funcImports?: FuncImport[];
  tagImports?: TagImport[];
  tableImports?: TableImport[];
  tables?: DefinedTable[];
  globalImports?: GlobalImport[];
  types?: { params: number[]; results: number[] }[];
  funcTypes?: number[];        // type index per defined function
  memoryPointerWidths?: Array<4 | 8>;
  globals?: DefinedGlobal[];
  exports?: ExportEntry[];
  startFunctionIndex?: number;
  funcBodies?: FuncBody[];
  customSections?: { name: string; data?: number[] }[];
}): ArrayBuffer {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ];

  for (const custom of opts.customSections ?? []) {
    bytes.push(...section(0, [...nameBytes(custom.name), ...(custom.data ?? [])]));
  }

  // Default to one `() -> i32` type so __abi_version-like funcs work.
  const types = opts.types ?? [{ params: [], results: [0x7F] }];
  const typePayload = [...uleb128(types.length)];
  for (const type of types) {
    typePayload.push(
      0x60,
      ...uleb128(type.params.length),
      ...type.params,
      ...uleb128(type.results.length),
      ...type.results,
    );
  }
  bytes.push(...section(1, typePayload));

  // Import section (id=2)
  const fImps = opts.funcImports ?? [];
  const tImps = opts.tagImports ?? [];
  const tableImps = opts.tableImports ?? [];
  const gImps = opts.globalImports ?? [];
  if (fImps.length + tImps.length + tableImps.length + gImps.length > 0) {
    const payload: number[] = [
      ...uleb128(fImps.length + tImps.length + tableImps.length + gImps.length),
    ];
    for (const fi of fImps) {
      payload.push(...nameBytes(fi.module), ...nameBytes(fi.name), 0x00, ...uleb128(fi.typeIdx));
    }
    for (const ti of tImps) {
      payload.push(
        ...nameBytes(ti.module),
        ...nameBytes(ti.name),
        0x04,
        0x00,
        ...uleb128(ti.typeIdx),
      );
    }
    for (const table of tableImps) {
      const flags = (table.maximum === null ? 0 : 1) | (table.table64 ? 4 : 0);
      payload.push(
        ...nameBytes(table.module),
        ...nameBytes(table.name),
        0x01,
        table.elementType,
        ...uleb128(flags),
        ...uleb128(table.minimum),
        ...(table.maximum === null ? [] : uleb128(table.maximum)),
      );
    }
    for (const gi of gImps) {
      payload.push(
        ...nameBytes(gi.module),
        ...nameBytes(gi.name),
        0x03,
        gi.valType,
        gi.mut | (gi.shared ? 0b10 : 0),
      );
    }
    bytes.push(...section(2, payload));
  }

  // Function section (id=3) — type indices for defined functions
  const fTypes = opts.funcTypes ?? [];
  if (fTypes.length > 0) {
    const payload: number[] = [...uleb128(fTypes.length)];
    for (const t of fTypes) payload.push(...uleb128(t));
    bytes.push(...section(3, payload));
  }

  const tables = opts.tables ?? [];
  if (tables.length > 0) {
    const payload: number[] = [...uleb128(tables.length)];
    for (const table of tables) {
      const flags = (table.maximum === null ? 0 : 1) | (table.table64 ? 4 : 0);
      payload.push(
        table.elementType,
        ...uleb128(flags),
        ...uleb128(table.minimum),
        ...(table.maximum === null ? [] : uleb128(table.maximum)),
      );
    }
    bytes.push(...section(4, payload));
  }

  const memoryPointerWidths = opts.memoryPointerWidths ?? [];
  if (memoryPointerWidths.length > 0) {
    const payload = [...uleb128(memoryPointerWidths.length)];
    for (const pointerWidth of memoryPointerWidths) {
      payload.push(pointerWidth === 8 ? 0x04 : 0x00, 0x01);
    }
    bytes.push(...section(5, payload));
  }

  // Global section (id=6)
  const gs = opts.globals ?? [];
  if (gs.length > 0) {
    const payload: number[] = [...uleb128(gs.length)];
    for (const g of gs) {
      payload.push(g.valType, g.mut, ...g.init, 0x0B);
    }
    bytes.push(...section(6, payload));
  }

  // Export section (id=7)
  const es = opts.exports ?? [];
  if (es.length > 0) {
    const payload: number[] = [...uleb128(es.length)];
    for (const e of es) {
      payload.push(...nameBytes(e.name), e.kind, ...uleb128(e.index));
    }
    bytes.push(...section(7, payload));
  }

  if (opts.startFunctionIndex !== undefined) {
    bytes.push(...section(8, uleb128(opts.startFunctionIndex)));
  }

  // Code section (id=10)
  const bodies = opts.funcBodies ?? [];
  if (bodies.length > 0) {
    const payload: number[] = [...uleb128(bodies.length)];
    for (const b of bodies) {
      const body: number[] = [...b.locals, ...b.instructions, 0x0B];
      payload.push(...uleb128(body.length), ...body);
    }
    bytes.push(...section(10, payload));
  }

  return new Uint8Array(bytes).buffer;
}

const I32 = 0x7F;
const I64 = 0x7E;

function linkedFrameDescriptor(pointerWidth: 4 | 8): number[] {
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === pointerWidth,
  );
  if (!pointerFormat) throw new Error(`unsupported pointer width ${pointerWidth}`);
  const bytes = new Uint8Array(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE);
  bytes.set(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_LINKED_FRAME_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, true);
  view.setUint8(8, pointerWidth);
  view.setUint8(9, WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT);
  view.setUint16(10, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, true);
  view.setUint32(12, pointerFormat.chunkHeaderSize, true);
  view.setUint32(16, pointerFormat.nodeHeaderSize, true);
  view.setUint32(20, 16, true);
  return [...bytes];
}

function moduleStateDescriptor(pointerWidth: 4 | 8): number[] {
  const bytes = new Uint8Array(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE);
  bytes.set(WPK_FORK_MODULE_STATE_FORMAT_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_MODULE_STATE_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE, true);
  view.setUint8(8, pointerWidth);
  view.setUint8(9, WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT);
  view.setUint16(10, WPK_FORK_MODULE_STATE_REQUIRED_FLAGS, true);
  view.setUint16(12, WPK_FORK_MODULE_STATE_ARENA_VERSION, true);
  view.setUint16(14, WPK_FORK_MODULE_STATE_RECORD_VERSION, true);
  view.setUint32(16, WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET, true);
  return [...bytes];
}

function exceptionCodecDescriptor(
  tags: Array<{
    ordinal: number;
    layoutId: number;
    scalarByteLength: number;
    referenceCount: number;
  }> = [],
): number[] {
  const bytes = new Uint8Array(
    WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE
      + tags.length * WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE,
  );
  const view = new DataView(bytes.buffer);
  view.setUint8(0, WPK_FORK_EXCEPTION_CODEC_VERSION);
  view.setUint32(4, tags.length, true);
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]!;
    const offset = WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE
      + index * WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;
    view.setUint32(offset, tag.ordinal, true);
    view.setUint32(offset + 4, tag.layoutId, true);
    view.setUint32(offset + 8, tag.scalarByteLength, true);
    view.setUint32(offset + 12, tag.referenceCount, true);
  }
  return [...bytes];
}

function emptyImportedGlobalsDescriptor(): number[] {
  return importedGlobalsDescriptor([]);
}

const COMPLETE_FORK_SOURCE_TABLE_IMPORT_ORDINAL =
  1 + WPK_FORK_REQUIRED_IMPORTS.length + 1;
const COMPLETE_FORK_SOURCE_GLOBAL_IMPORT_ORDINAL =
  COMPLETE_FORK_SOURCE_TABLE_IMPORT_ORDINAL
  + WPK_FORK_REQUIRED_TABLE_IMPORTS.length;

function importedGlobalsDescriptor(
  records: Array<{
    owner: number;
    typeCode: number;
    flags: number;
    module: string;
    name: string;
    importOrdinal?: number;
  }>,
): number[] {
  const encoded = records.map((record, index) => ({
    ...record,
    importOrdinal:
      record.importOrdinal ?? COMPLETE_FORK_SOURCE_GLOBAL_IMPORT_ORDINAL + index,
    moduleBytes: new TextEncoder().encode(record.module),
    nameBytes: new TextEncoder().encode(record.name),
  }));
  const byteLength = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE
    + encoded.reduce(
      (total, record) =>
        total
        + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
        + record.moduleBytes.length
        + record.nameBytes.length,
      0,
  );
  const bytes = new Uint8Array(byteLength);
  bytes.set(WPK_FORK_IMPORTED_GLOBALS_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_IMPORTED_GLOBALS_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE, true);
  view.setUint32(8, encoded.length, true);
  let offset = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE;
  for (const record of encoded) {
    const recordSize = WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
      + record.moduleBytes.length
      + record.nameBytes.length;
    view.setUint32(offset, recordSize, true);
    view.setUint32(offset + 4, record.owner, true);
    view.setUint8(offset + 8, record.typeCode);
    view.setUint8(offset + 9, record.flags);
    view.setUint32(offset + 12, record.moduleBytes.length, true);
    view.setUint32(offset + 16, record.nameBytes.length, true);
    view.setUint32(offset + 20, record.importOrdinal, true);
    bytes.set(
      record.moduleBytes,
      offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
    );
    bytes.set(
      record.nameBytes,
      offset
        + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
        + record.moduleBytes.length,
    );
    offset += recordSize;
  }
  return [...bytes];
}

function importedTablesDescriptor(
  records: Array<{
    owner: number;
    typeCode: number;
    flags: number;
    module: string;
    name: string;
    importOrdinal?: number;
  }>,
): number[] {
  const encoded = records.map((record, index) => ({
    ...record,
    importOrdinal:
      record.importOrdinal ?? COMPLETE_FORK_SOURCE_TABLE_IMPORT_ORDINAL + index,
    moduleBytes: new TextEncoder().encode(record.module),
    nameBytes: new TextEncoder().encode(record.name),
  }));
  const byteLength = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE
    + encoded.reduce(
      (total, record) =>
        total
        + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
        + record.moduleBytes.length
        + record.nameBytes.length,
      0,
    );
  const bytes = new Uint8Array(byteLength);
  bytes.set(WPK_FORK_IMPORTED_TABLES_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_IMPORTED_TABLES_VERSION, true);
  view.setUint16(6, WPK_FORK_IMPORTED_TABLES_HEADER_SIZE, true);
  view.setUint32(8, encoded.length, true);
  let offset = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE;
  for (const record of encoded) {
    const recordSize = WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
      + record.moduleBytes.length
      + record.nameBytes.length;
    view.setUint32(offset, recordSize, true);
    view.setUint32(offset + 4, record.owner, true);
    view.setUint8(offset + 8, record.typeCode);
    view.setUint8(offset + 9, record.flags);
    view.setUint32(offset + 12, record.moduleBytes.length, true);
    view.setUint32(offset + 16, record.nameBytes.length, true);
    view.setUint32(offset + 20, record.importOrdinal, true);
    bytes.set(
      record.moduleBytes,
      offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE,
    );
    bytes.set(
      record.nameBytes,
      offset
        + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
        + record.moduleBytes.length,
    );
    offset += recordSize;
  }
  return [...bytes];
}

function staticRootCatalogDescriptor(count = 0): number[] {
  const bytes = new Uint8Array(WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE);
  bytes.set(WPK_FORK_STATIC_ROOT_CATALOG_MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, WPK_FORK_STATIC_ROOT_CATALOG_VERSION, true);
  view.setUint16(6, WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE, true);
  view.setUint32(8, count, true);
  return [...bytes];
}

type ForkArtifactValueType =
  | "ptr"
  | "i32"
  | "i64"
  | "anyref"
  | "exnref"
  | "externref"
  | "funcref";

function wasmValueType(
  value: ForkArtifactValueType,
  pointerWidth: 4 | 8,
): number {
  switch (value) {
    case "ptr":
      return pointerWidth === 8 ? I64 : I32;
    case "i32":
      return I32;
    case "i64":
      return I64;
    case "anyref":
      return 0x6e;
    case "exnref":
      return 0x69;
    case "externref":
      return 0x6f;
    case "funcref":
      return 0x70;
  }
}

function completeForkWasm(options: {
  pointerWidth?: 4 | 8;
  kernelForkParams?: readonly ForkArtifactValueType[];
  memoryPointerWidth?: 4 | 8;
  exportPointerWidth?: 4 | 8;
  capabilityFlags?: number | null;
  capabilityPayloads?: number[][];
  unwindTransportPayloads?: number[][];
  moduleStatePayloads?: number[][];
  exceptionCodecPayloads?: number[][];
  importedGlobalsPayloads?: number[][];
  importedTablesPayloads?: number[][];
  includeActivationImport?: boolean;
  sourceGlobalImports?: GlobalImport[];
  sourceTableImports?: TableImport[];
  includeGlobalCatalog?: boolean;
  includeTableCatalog?: boolean;
  includeResumeTable?: boolean;
  staticRootPayloads?: number[][];
  includeStaticRootTable?: boolean;
  staticRootCount?: number;
  includeUnwindTag?: boolean;
  includeLegacyDlopenImport?: boolean;
  includeNativeStart?: boolean;
  abiVersion?: number;
  includeAbiMarker?: boolean;
  checkpointImportParams?: ReadonlyArray<readonly ForkArtifactValueType[]>;
} = {}): ArrayBuffer {
  const pointerWidth = options.pointerWidth ?? 4;
  const exportPointerWidth = options.exportPointerWidth ?? pointerWidth;
  const types: Array<{ params: number[]; results: number[] }> = [];
  const typeIndices = new Map<string, number>();
  const internType = (
    params: readonly ForkArtifactValueType[],
    results: readonly ForkArtifactValueType[],
    width: 4 | 8,
  ): number => {
    const type = {
      params: params.map((value) => wasmValueType(value, width)),
      results: results.map((value) => wasmValueType(value, width)),
    };
    const key = `${type.params.join(",")}=>${type.results.join(",")}`;
    const existing = typeIndices.get(key);
    if (existing !== undefined) return existing;
    const index = types.length;
    types.push(type);
    typeIndices.set(key, index);
    return index;
  };
  const kernelForkType = internType(
    options.kernelForkParams ?? ["i32"],
    ["i32"],
    pointerWidth,
  );
  const emptyType = internType([], [], pointerWidth);
  const funcImports: FuncImport[] = [
    { module: "kernel", name: "kernel_fork", typeIdx: kernelForkType },
    ...(options.checkpointImportParams ?? []).map((params) => ({
      module: WPK_CHECKPOINT_PROCESS_IMPORT.module,
      name: WPK_CHECKPOINT_PROCESS_IMPORT.name,
      typeIdx: internType(params, [], pointerWidth),
    })),
    ...(options.includeLegacyDlopenImport === true
      ? [{
          module: "env",
          name: "__wasm_dlopen",
          typeIdx: internType(
            ["ptr", "i32", "ptr", "i32", "i32"],
            ["i32"],
            pointerWidth,
          ),
        }]
      : []),
    ...WPK_FORK_REQUIRED_IMPORTS.map((requirement) => ({
      module: requirement.module,
      name: requirement.name,
      typeIdx: internType(requirement.params, requirement.results, pointerWidth),
    })),
  ];
  const forkTypeIndices = WPK_FORK_REQUIRED_EXPORTS.map((requirement) =>
    internType(requirement.params, requirement.results, exportPointerWidth)
  );
  const abiType = internType([], ["i32"], pointerWidth);
  const firstDefinedFunction = funcImports.length;
  const capabilityFlags =
    options.capabilityFlags === undefined
      ? WPK_FORK_CAP_ACTIVATION_STATE_SAFE
      : options.capabilityFlags;
  const capabilityPayloads = options.capabilityPayloads ??
    (capabilityFlags === null
      ? []
      : [[WPK_FORK_CAPABILITIES_VERSION, capabilityFlags]]);
  const sourceGlobalImports = options.sourceGlobalImports ?? [];
  const sourceTableImports = options.sourceTableImports ?? [];
  const activationGlobalImports: GlobalImport[] =
    options.includeActivationImport === false ? [] : [{
      module: WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE,
      name: WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
      valType: I32,
      mut: 0,
    }];
  const requiredTableImports = options.includeResumeTable === false
    ? []
    : WPK_FORK_REQUIRED_TABLE_IMPORTS.map((requirement) => ({
      module: requirement.module,
      name: requirement.name,
      elementType: wasmValueType(requirement.element, pointerWidth),
      table64: requirement.table64,
      minimum: requirement.minimum,
      maximum: requirement.maximum,
    }));
  const staticRootCount = options.staticRootCount ?? 0;
  const nativeStartLocalIndex = WPK_FORK_REQUIRED_EXPORTS.findIndex(
    (requirement) =>
      requirement.params.length === 0 && requirement.results.length === 0,
  );
  if (options.includeNativeStart === true && nativeStartLocalIndex < 0) {
    throw new Error("fork fixture has no () -> () function for its native start");
  }
  return buildWasm({
    customSections: [
      ...capabilityPayloads.map((data) => ({
        name: WPK_FORK_CAPABILITIES_SECTION,
        data,
      })),
      {
        name: WPK_FORK_LINKED_FRAME_FORMAT_SECTION,
        data: linkedFrameDescriptor(pointerWidth),
      },
      ...(options.exceptionCodecPayloads ??
        [exceptionCodecDescriptor()]).map((data) => ({
          name: WPK_FORK_EXCEPTION_CODEC_SECTION,
          data,
        })),
      ...(options.importedGlobalsPayloads ??
        [emptyImportedGlobalsDescriptor()]).map((data) => ({
          name: WPK_FORK_IMPORTED_GLOBALS_SECTION,
          data,
        })),
      ...(options.importedTablesPayloads ??
        [importedTablesDescriptor([])]).map((data) => ({
          name: WPK_FORK_IMPORTED_TABLES_SECTION,
          data,
        })),
      ...(options.moduleStatePayloads ?? [moduleStateDescriptor(pointerWidth)]).map(
        (data) => ({
          name: WPK_FORK_MODULE_STATE_FORMAT_SECTION,
          data,
        }),
      ),
      ...(options.staticRootPayloads ??
        [staticRootCatalogDescriptor(staticRootCount)]).map((data) => ({
          name: WPK_FORK_STATIC_ROOT_CATALOG_SECTION,
          data,
        })),
      ...(options.unwindTransportPayloads ?? [[
        FORK_UNWIND_TRANSPORT_VERSION,
        FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
      ]]).map((data) => ({
        name: FORK_UNWIND_TRANSPORT_SECTION,
        data,
      })),
    ],
    types,
    funcImports,
    globalImports: [...sourceGlobalImports, ...activationGlobalImports],
    tableImports: [...sourceTableImports, ...requiredTableImports],
    tables: options.includeStaticRootTable === false ? [] : [{
      elementType: wasmValueType("anyref", pointerWidth),
      table64: false,
      minimum: staticRootCount,
      maximum: staticRootCount,
    }],
    tagImports: options.includeUnwindTag === false ? [] : [{
      module: FORK_UNWIND_TAG_IMPORT_MODULE,
      name: FORK_UNWIND_TAG_IMPORT_NAME,
      typeIdx: emptyType,
    }],
    funcTypes: [...forkTypeIndices, abiType],
    memoryPointerWidths: [options.memoryPointerWidth ?? pointerWidth],
    exports: [
      ...WPK_FORK_REQUIRED_EXPORTS.map((requirement, index) => ({
        name: requirement.name,
        kind: 0 as const,
        index: firstDefinedFunction + index,
      })),
      ...(options.includeAbiMarker === false ? [] : [{
        name: "__abi_version",
        kind: 0 as const,
        index: firstDefinedFunction + forkTypeIndices.length,
      }]),
      ...(options.includeGlobalCatalog === false
        ? []
        : sourceGlobalImports.map((_global, index) => ({
          name: `${WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX}${index + 1}`,
          kind: 3 as const,
          index,
        }))),
      ...(options.includeTableCatalog === false
        ? []
        : sourceTableImports.map((_table, index) => ({
          name: `${WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX}${index + 1}`,
          kind: 1 as const,
          index,
        }))),
      ...(options.includeStaticRootTable === false ? [] : [{
        name: WPK_FORK_STATIC_ROOT_CATALOG_EXPORT,
        kind: 1 as const,
        index: sourceTableImports.length + requiredTableImports.length,
      }]),
    ],
    ...(options.includeNativeStart === true
      ? { startFunctionIndex: firstDefinedFunction + nativeStartLocalIndex }
      : {}),
    funcBodies: [
      ...WPK_FORK_REQUIRED_EXPORTS.map((requirement) => ({
        locals: [0],
        instructions: requirement.results.length === 0
          ? []
          : requirement.results[0] === "i32"
          ? [0x41, 0]
          : requirement.results[0] === "i64"
          ? [0x42, 0]
          : [0x00],
      })),
      {
        locals: [0],
        instructions: [0x41, ...sleb128_i32(options.abiVersion ?? ABI_VERSION)],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// extractHeapBase
// ---------------------------------------------------------------------------

describe("extractHeapBase", () => {
  it("returns null for an empty/too-short binary", () => {
    expect(extractHeapBase(new ArrayBuffer(0))).toBeNull();
    expect(extractHeapBase(new ArrayBuffer(4))).toBeNull();
  });

  it("returns null when no __heap_base export is present", () => {
    const wasm = buildWasm({
      globals: [{ valType: I32, mut: 0, init: [0x41, ...sleb128_i32(0x100000)] }],
      exports: [{ name: "other", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBeNull();
  });

  it("reads an i32 __heap_base from a defined global (wasm32)", () => {
    const wasm = buildWasm({
      globals: [{ valType: I32, mut: 0, init: [0x41, ...sleb128_i32(17_106_736)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBe(17_106_736n);
  });

  it("reads an i32 __heap_base above the import-global offset", () => {
    // 1 imported global (index 0) + 1 defined global (index 1) → __heap_base = global 1
    const wasm = buildWasm({
      globalImports: [{ module: "env", name: "__channel_base", valType: I32, mut: 1 }],
      globals: [{ valType: I32, mut: 0, init: [0x41, ...sleb128_i32(0x1051D70)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 1 }],
    });
    expect(extractHeapBase(wasm)).toBe(0x1051D70n);
  });

  it("skips a preceding global whose constant immediate contains the end opcode byte", () => {
    const wasm = buildWasm({
      globals: [
        { valType: I32, mut: 0, init: [0x41, ...sleb128_i32(11)] },
        { valType: I32, mut: 0, init: [0x41, ...sleb128_i32(0x1051D70)] },
      ],
      exports: [{ name: "__heap_base", kind: 3, index: 1 }],
    });
    expect(extractHeapBase(wasm)).toBe(0x1051D70n);
  });

  it("reads an i64 __heap_base for wasm64", () => {
    const expected = 0x100000000n; // 4 GiB
    const wasm = buildWasm({
      globals: [{ valType: I64, mut: 0, init: [0x42, ...sleb128_i64(expected)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBe(expected);
  });

  it("returns null when __heap_base is imported (no init expression to read)", () => {
    const wasm = buildWasm({
      globalImports: [{ module: "env", name: "__heap_base", valType: I32, mut: 0 }],
      exports: [{ name: "__heap_base", kind: 3, index: 0 }],
    });
    expect(extractHeapBase(wasm)).toBeNull();
  });

  it("returns null for a non-const init expression", () => {
    // 0x23 = global.get; an unsupported init form for our purposes.
    const wasm = buildWasm({
      globalImports: [{ module: "env", name: "src", valType: I32, mut: 0 }],
      globals: [{ valType: I32, mut: 0, init: [0x23, ...uleb128(0)] }],
      exports: [{ name: "__heap_base", kind: 3, index: 1 }],
    });
    expect(extractHeapBase(wasm)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAbiVersion
// ---------------------------------------------------------------------------

function abiVersionBody(value: number): FuncBody {
  // Mirrors what libc/glue/channel_syscall.c emits: __wasm_call_ctors prefix
  // (call <ctors-func-idx>) then `i32.const value`.
  return {
    locals: [0x00],                                // 0 local groups
    instructions: [
      0x10, ...uleb128(0),                          // call func 0 (the ctors stub)
      0x41, ...sleb128_i32(value),                  // i32.const value
    ],
  };
}

describe("extractAbiVersion", () => {
  it("returns null for an empty binary", () => {
    expect(extractAbiVersion(new ArrayBuffer(0))).toBeNull();
  });

  it("returns null when no __abi_version export is present", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(7)],
      exports: [{ name: "_start", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBeNull();
  });

  it("reads the i32.const after the ctors-call prefix", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(7)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(7);
  });

  it("handles the export wrapper for older ABI values", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(6)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(6);
  });

  it("ignores instrumentation constants before the ABI return value", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [{
        locals: [0x00],
        instructions: [
          0x02, 0x40,              // block
          0x41, ...sleb128_i32(2), // instrumentation constant
          0x1a,                    // drop
          0x0b,                    // end block
          0x10, ...uleb128(0),      // call ctors stub
          0x41, ...sleb128_i32(12), // actual ABI version
          0x0f,                    // return
        ],
      }],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(12);
  });

  it("follows an instrumented command-export wrapper to the real ABI marker", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [
        {
          locals: [0x00],
          instructions: [
            0x02, 0x40,               // block
            0x41, ...sleb128_i32(2),  // fork-state constant
            0x1a,                     // drop
            0x0b,                     // end block
            0x10, ...uleb128(1),      // call real marker
            0x0f,                     // return
            0x41, ...sleb128_i32(0),  // wrapper default path, not ABI
          ],
        },
        {
          locals: [0x00],
          instructions: [
            0x41, ...sleb128_i32(12),
          ],
        },
      ],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractAbiVersion(wasm)).toBe(12);
  });

  it("counts function imports correctly when computing the body index", () => {
    // 1 func import (index 0) + 1 defined function (index 1) → __abi_version = func 1
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_get_argc", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(7)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });
    expect(extractAbiVersion(wasm)).toBe(7);
  });
});

describe("extractThreadSlotDeclaration", () => {
  it("returns null when the process-wasm declaration export is absent", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(-1)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });
    expect(extractThreadSlotDeclaration(wasm)).toBeNull();
  });

  it("reads the signed i32 thread slot declaration", () => {
    for (const value of [-1, 0, 3]) {
      const wasm = buildWasm({
        funcTypes: [0],
        funcBodies: [abiVersionBody(value)],
        exports: [{ name: "__wasm_posix_thread_slots", kind: 0, index: 0 }],
      });
      expect(extractThreadSlotDeclaration(wasm)).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// Wasm artifact policy helpers
// ---------------------------------------------------------------------------

describe("wasm artifact policy helpers", () => {
  it("reads import and export names without compiling the module", () => {
    const wasm = buildWasm({
      funcImports: [
        { module: "kernel", name: "kernel_fork", typeIdx: 0 },
        { module: "kernel", name: "kernel_clone", typeIdx: 0 },
      ],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [
        { name: "__abi_version", kind: 0, index: 2 },
        { name: "wpk_fork_state", kind: 0, index: 2 },
      ],
    });

    expect(readWasmImportNames(wasm)).toEqual([
      "kernel.kernel_fork",
      "kernel.kernel_clone",
    ]);
    expect(readWasmExportNames(wasm)).toContain("wpk_fork_state");
    expect(wasmImportsKernelFork(wasm)).toBe(true);
  });

  it("flags fork-capable wasm without the complete instrumentation exports", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [
        { name: "__abi_version", kind: 0, index: 1 },
        { name: "wpk_fork_state", kind: 0, index: 1 },
      ],
    });

    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    const failures = describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 });
    expect(failures.some((failure) =>
      failure.startsWith("incomplete wasm-fork-instrument exports; missing ")
      && failure.includes("__wpk_fork_ref_decode_exnref")
      && failure.includes("wpk_fork_unwind_end")
    )).toBe(true);
    expect(failures).toContain(
      `missing required ${WPK_FORK_LINKED_FRAME_FORMAT_SECTION} descriptor`,
    );
    expect(failures.some((failure) =>
      failure.startsWith("incomplete ABI 43 fork-runtime imports; missing ")
      && failure.includes("env.__wpk_fork_frame_commit")
      && failure.includes("env.__wpk_fork_ref_exn_define")
    )).toBe(true);
  });

  it("accepts the complete ABI 43 contract for wasm32 and wasm64", () => {
    for (const pointerWidth of [4, 8] as const) {
      const wasm = completeForkWasm({ pointerWidth });
      expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(true);
      expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: ABI_VERSION })).toEqual([]);
    }
  });

  it("rejects the obsolete no-argument process-fork import", () => {
    const wasm = completeForkWasm({ kernelForkParams: [] });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toContain(
      "ABI 43 process-fork import kernel.kernel_fork has the wrong "
        + "signature; expected (i32) -> (i32)",
    );
  });

  it("accepts a single well-formed process-checkpoint import", () => {
    const wasm = completeForkWasm({ checkpointImportParams: [[]] });
    expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: ABI_VERSION }))
      .toEqual([]);
  });

  it("rejects a duplicate process-checkpoint import", () => {
    const wasm = completeForkWasm({ checkpointImportParams: [[], []] });
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toContain(
      "duplicate ABI 44 process-checkpoint import kernel.kernel_checkpoint",
    );
  });

  it("rejects a process-checkpoint import with the wrong signature", () => {
    const wasm = completeForkWasm({ checkpointImportParams: [["i32"]] });
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toContain(
      "ABI 44 process-checkpoint import kernel.kernel_checkpoint has the "
        + "wrong signature; expected () -> ()",
    );
  });

  it("requires the exact private exception transport before accepting ABI 43 safety", () => {
    const cases: Array<{
      label: string;
      options: Parameters<typeof completeForkWasm>[0];
      diagnostic: string;
    }> = [
      {
        label: "missing tag",
        options: { includeUnwindTag: false },
        diagnostic: "missing required private fork-unwind tag import",
      },
      {
        label: "missing descriptor",
        options: { unwindTransportPayloads: [] },
        diagnostic: `missing required ${FORK_UNWIND_TRANSPORT_SECTION} descriptor`,
      },
      {
        label: "wrong descriptor",
        options: { unwindTransportPayloads: [[FORK_UNWIND_TRANSPORT_VERSION, 1]] },
        diagnostic: `${FORK_UNWIND_TRANSPORT_SECTION} must be`,
      },
      {
        label: "duplicate descriptor",
        options: {
          unwindTransportPayloads: [
            [FORK_UNWIND_TRANSPORT_VERSION, FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY],
            [FORK_UNWIND_TRANSPORT_VERSION, FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY],
          ],
        },
        diagnostic: "descriptors, expected exactly one",
      },
    ];

    for (const { label, options, diagnostic } of cases) {
      const wasm = completeForkWasm(options);
      expect(wasmHasCompleteForkInstrumentation(wasm), label).toBe(false);
      expect(describeWasmArtifactPolicyFailures(wasm).join("\n"), label)
        .toContain(diagnostic);
    }
  });

  it("requires module-state ownership metadata in the same pointer-width epoch", () => {
    const missing = completeForkWasm({ moduleStatePayloads: [] });
    expect(describeWasmArtifactPolicyFailures(missing).join("\n"))
      .toContain(`missing required ${WPK_FORK_MODULE_STATE_FORMAT_SECTION} descriptor`);

    const mismatched = completeForkWasm({
      pointerWidth: 8,
      moduleStatePayloads: [moduleStateDescriptor(4)],
    });
    expect(describeWasmArtifactPolicyFailures(mismatched).join("\n"))
      .toContain("pointer width 4 does not match linked frames 8");
  });

  it("accepts shape-neutral exact-tag exception codec catalogs", () => {
    const descriptor = exceptionCodecDescriptor([
      {
        ordinal: 0,
        layoutId: 17,
        scalarByteLength: 40,
        referenceCount: 0,
      },
      {
        ordinal: 1,
        layoutId: 29,
        scalarByteLength: 24,
        referenceCount: 7,
      },
    ]);
    const wasm = completeForkWasm({ exceptionCodecPayloads: [descriptor] });

    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(true);
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toEqual([]);
  });

  it("rejects malformed exception reconstruction metadata, not exception shapes", () => {
    const noncanonical = exceptionCodecDescriptor([
      {
        ordinal: 1,
        layoutId: 4,
        scalarByteLength: 0,
        referenceCount: 0,
      },
    ]);
    const duplicateLayout = exceptionCodecDescriptor([
      {
        ordinal: 0,
        layoutId: 9,
        scalarByteLength: 0,
        referenceCount: 0,
      },
      {
        ordinal: 1,
        layoutId: 9,
        scalarByteLength: 0,
        referenceCount: 2,
      },
    ]);
    const reserved = exceptionCodecDescriptor();
    reserved[1] = 1;
    const cases = [
      {
        label: "missing",
        payloads: [] as number[][],
        diagnostic: `missing required ${WPK_FORK_EXCEPTION_CODEC_SECTION} descriptor`,
      },
      {
        label: "duplicate",
        payloads: [exceptionCodecDescriptor(), exceptionCodecDescriptor()],
        diagnostic: "descriptors, expected exactly one",
      },
      {
        label: "truncated",
        payloads: [[WPK_FORK_EXCEPTION_CODEC_VERSION]],
        diagnostic: "descriptor is truncated",
      },
      {
        label: "reserved",
        payloads: [reserved],
        diagnostic: "reserved fields are nonzero",
      },
      {
        label: "noncanonical ordinal",
        payloads: [noncanonical],
        diagnostic: "tag ordinal 1 is noncanonical at 0",
      },
      {
        label: "duplicate layout",
        payloads: [duplicateLayout],
        diagnostic: "layout id 9 is invalid or duplicated",
      },
    ];

    for (const { label, payloads, diagnostic } of cases) {
      const failures = describeWasmArtifactPolicyFailures(
        completeForkWasm({ exceptionCodecPayloads: payloads }),
      );
      expect(failures.join("\n"), label).toContain(diagnostic);
    }
  });

  it("requires pre-instantiation global recipes and private codec bindings", () => {
    const missingGlobals = completeForkWasm({ importedGlobalsPayloads: [] });
    expect(describeWasmArtifactPolicyFailures(missingGlobals).join("\n"))
      .toContain(`missing required ${WPK_FORK_IMPORTED_GLOBALS_SECTION} descriptor`);

    const missingTables = completeForkWasm({ importedTablesPayloads: [] });
    expect(describeWasmArtifactPolicyFailures(missingTables).join("\n"))
      .toContain(`missing required ${WPK_FORK_IMPORTED_TABLES_SECTION} descriptor`);

    const missingActivation = completeForkWasm({ includeActivationImport: false });
    expect(describeWasmArtifactPolicyFailures(missingActivation).join("\n"))
      .toContain("missing required immutable exception-codec activation import");

    const missingResumeTable = completeForkWasm({ includeResumeTable: false });
    expect(describeWasmArtifactPolicyFailures(missingResumeTable).join("\n"))
      .toContain("missing required ABI 43 fork-runtime table import");
  });

  it("binds duplicate and table64 import recipes one declaration at a time", () => {
    const sourceTableImports: TableImport[] = [
      {
        module: "env",
        name: "dispatch",
        elementType: 0x70,
        table64: false,
        minimum: 1,
        maximum: 8,
      },
      {
        module: "env",
        name: "dispatch",
        elementType: 0x70,
        table64: false,
        minimum: 1,
        maximum: 8,
      },
      {
        module: "state",
        name: "objects",
        elementType: 0x6f,
        table64: true,
        minimum: 0,
        maximum: null,
      },
    ];
    const descriptor = importedTablesDescriptor([
      {
        owner: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        flags: 0,
        module: "env",
        name: "dispatch",
      },
      {
        owner: 2,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
        flags: 0,
        module: "env",
        name: "dispatch",
      },
      {
        owner: 3,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        flags: WPK_FORK_IMPORTED_TABLES_FLAG_TABLE64,
        module: "state",
        name: "objects",
      },
    ]);
    const wasm = completeForkWasm({
      sourceTableImports,
      importedTablesPayloads: [descriptor],
    });

    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(true);
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toEqual([]);
  });

  it("rejects copied or incomplete imported-table ownership claims", () => {
    const sourceTableImports: TableImport[] = [{
      module: "env",
      name: "dispatch",
      elementType: 0x70,
      table64: false,
      minimum: 1,
      maximum: 8,
    }];
    const correctRecord = {
      owner: 1,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
      flags: 0,
      module: "env",
      name: "dispatch",
    };
    const cases = [
      {
        label: "empty copied descriptor",
        options: {
          sourceTableImports,
          importedTablesPayloads: [importedTablesDescriptor([])],
        },
        diagnostic: "omits imported table env.dispatch at index 0",
      },
      {
        label: "wrong declaration type",
        options: {
          sourceTableImports,
          importedTablesPayloads: [importedTablesDescriptor([{
            ...correctRecord,
            typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
          }])],
        },
        diagnostic: "owner 1 does not match its imported table declaration",
      },
      {
        label: "missing catalog owner",
        options: {
          sourceTableImports,
          importedTablesPayloads: [
            importedTablesDescriptor([correctRecord]),
          ],
          includeTableCatalog: false,
        },
        diagnostic: "owner 1 lacks exactly one table catalog export",
      },
    ];

    for (const { label, options, diagnostic } of cases) {
      expect(
        describeWasmArtifactPolicyFailures(
          completeForkWasm(options),
        ).join("\n"),
        label,
      ).toContain(diagnostic);
    }
  });

  it("binds duplicate, reference, mutable, and shared global recipes one-for-one", () => {
    const sourceGlobalImports: GlobalImport[] = [
      {
        module: "env",
        name: "callback",
        valType: 0x6f,
        mut: 0,
      },
      {
        module: "env",
        name: "callback",
        valType: 0x6f,
        mut: 0,
      },
      {
        module: "state",
        name: "epoch",
        valType: I32,
        mut: 1,
        shared: true,
      },
      {
        // This fresh-child process binding is intentionally catalogued but
        // reconstructed by the host before instantiation, not by KFIG.
        module: "env",
        name: "__channel_base",
        valType: I32,
        mut: 0,
      },
    ];
    const descriptor = importedGlobalsDescriptor([
      {
        owner: 1,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        flags: 0,
        module: "env",
        name: "callback",
      },
      {
        owner: 2,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
        flags: 0,
        module: "env",
        name: "callback",
      },
      {
        owner: 3,
        typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
        flags:
          WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE
          | WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED,
        module: "state",
        name: "epoch",
      },
    ]);
    const wasm = completeForkWasm({
      sourceGlobalImports,
      importedGlobalsPayloads: [descriptor],
    });

    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(true);
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toEqual([]);
  });

  it("rejects copied or incomplete imported-global ownership claims", () => {
    const sourceGlobalImports: GlobalImport[] = [{
      module: "env",
      name: "callback",
      valType: 0x6f,
      mut: 1,
    }];
    const correctRecord = {
      owner: 1,
      typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
      flags: WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE,
      module: "env",
      name: "callback",
    };
    const cases = [
      {
        label: "empty copied descriptor",
        options: {
          sourceGlobalImports,
          importedGlobalsPayloads: [emptyImportedGlobalsDescriptor()],
        },
        diagnostic: "omits imported global env.callback at index 0",
      },
      {
        label: "wrong declaration type",
        options: {
          sourceGlobalImports,
          importedGlobalsPayloads: [importedGlobalsDescriptor([{
            ...correctRecord,
            typeCode: WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
          }])],
        },
        diagnostic: "owner 1 does not match its imported global declaration",
      },
      {
        label: "missing catalog owner",
        options: {
          sourceGlobalImports,
          importedGlobalsPayloads: [
            importedGlobalsDescriptor([correctRecord]),
          ],
          includeGlobalCatalog: false,
        },
        diagnostic: "owner 1 lacks exactly one global catalog export",
      },
    ];

    for (const { label, options, diagnostic } of cases) {
      expect(
        describeWasmArtifactPolicyFailures(
          completeForkWasm(options),
        ).join("\n"),
        label,
      ).toContain(diagnostic);
    }
  });

  it("requires an exact fixed instance-local static-root catalog", () => {
    const badMagic = staticRootCatalogDescriptor();
    badMagic[0] ^= 0xff;
    const cases = [
      {
        label: "missing descriptor",
        options: { staticRootPayloads: [] },
        diagnostic: `missing required ${WPK_FORK_STATIC_ROOT_CATALOG_SECTION} descriptor`,
      },
      {
        label: "duplicate descriptor",
        options: {
          staticRootPayloads: [
            staticRootCatalogDescriptor(),
            staticRootCatalogDescriptor(),
          ],
        },
        diagnostic: "descriptors, expected exactly one",
      },
      {
        label: "invalid magic",
        options: { staticRootPayloads: [badMagic] },
        diagnostic: "has invalid magic",
      },
      {
        label: "missing table",
        options: { includeStaticRootTable: false },
        diagnostic: "missing exactly one table export",
      },
      {
        label: "descriptor/table length drift",
        options: {
          staticRootCount: 2,
          staticRootPayloads: [staticRootCatalogDescriptor(3)],
        },
        diagnostic: "fixed table32 anyref catalog of length 3",
      },
    ];

    for (const { label, options, diagnostic } of cases) {
      expect(
        describeWasmArtifactPolicyFailures(
          completeForkWasm(options),
        ).join("\n"),
        label,
      ).toContain(diagnostic);
    }
  });

  it("rejects every malformed or unsafe activation-state capability shape", () => {
    const cases: Array<{
      label: string;
      options: Parameters<typeof completeForkWasm>[0];
      diagnostic: string;
    }> = [
      {
        label: "missing",
        options: { capabilityFlags: null },
        diagnostic: `missing required ${WPK_FORK_CAPABILITIES_SECTION} capability`,
      },
      {
        label: "unsafe flags",
        options: { capabilityFlags: 0 },
        diagnostic: "omit required activation-state safety flags",
      },
      {
        label: "short payload",
        options: {
          capabilityPayloads: [[WPK_FORK_CAPABILITIES_VERSION]],
        },
        diagnostic: "has 1 bytes, expected 2",
      },
      {
        label: "unsupported version",
        options: {
          capabilityPayloads: [[
            WPK_FORK_CAPABILITIES_VERSION + 1,
            WPK_FORK_CAP_ACTIVATION_STATE_SAFE,
          ]],
        },
        diagnostic: "version 2 is unsupported",
      },
      {
        label: "unknown flags",
        options: {
          capabilityPayloads: [[
            WPK_FORK_CAPABILITIES_VERSION,
            WPK_FORK_CAP_KNOWN_MASK | 0x80,
          ]],
        },
        diagnostic: "has unknown flags",
      },
      {
        label: "duplicate",
        options: {
          capabilityPayloads: [
            [WPK_FORK_CAPABILITIES_VERSION, WPK_FORK_CAP_ACTIVATION_STATE_SAFE],
            [WPK_FORK_CAPABILITIES_VERSION, WPK_FORK_CAP_ACTIVATION_STATE_SAFE],
          ],
        },
        diagnostic: "sections, expected exactly one",
      },
    ];

    for (const { label, options, diagnostic } of cases) {
      const wasm = completeForkWasm(options);
      expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
      expect(
        describeWasmArtifactPolicyFailures(wasm).join("\n"),
        label,
      ).toContain(diagnostic);
    }
  });

  it("does not let an ABI 42 artifact masquerade as ABI 43 with a copied capability", () => {
    const wasm = completeForkWasm({ abiVersion: ABI_VERSION - 1 });
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toContain(`ABI ${ABI_VERSION - 1}, expected ${ABI_VERSION}`);
  });

  it("does not let a reentrant legacy loader import carry the ABI 43 safety claim", () => {
    const wasm = completeForkWasm({ includeLegacyDlopenImport: true });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm)).toContain(
      "ABI 43 fork artifact retains reentrant env.__wasm_dlopen; " +
        "rebuild and reinstrument it with the staged loader lowering",
    );
  });

  it("does not let a native start section carry the ABI 43 safety claim", () => {
    const wasm = completeForkWasm({ includeNativeStart: true });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm)).toContain(
      "ABI 43 fork artifact retains 1 native Wasm start section; rebuild and " +
        "reinstrument it so initialization is owned by wpk_fork_module_bootstrap",
    );
  });

  it("does not accept a fork capability without an ABI epoch marker", () => {
    const wasm = completeForkWasm({ includeAbiMarker: false });
    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toContain(
      `ABI ${ABI_VERSION} fork artifact is missing __abi_version; ` +
        "the activation-state capability epoch cannot be verified",
    );
  });

  it("rejects descriptor and module-memory pointer-width drift", () => {
    const wasm = completeForkWasm({ pointerWidth: 8, memoryPointerWidth: 4 });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm)).toContain(
      "ABI 43 linked-frame descriptor declares an 8-byte pointer but the module memory uses 4-byte addresses",
    );
  });

  it("rejects function signatures that drift from the descriptor pointer width", () => {
    const wasm = completeForkWasm({ pointerWidth: 8, exportPointerWidth: 4 });
    expect(wasmHasCompleteForkInstrumentation(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm)).toContain(
      "ABI 43 wasm-fork-instrument export wpk_fork_abort_begin has the wrong signature; expected (i64) -> ()",
    );
  });

  it("does not require fork instrumentation for thread-only kernel_clone imports", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_clone", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });

    expect(wasmImportsKernelFork(wasm)).toBe(false);
    expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 })).toEqual([]);
  });

  it("flags missing required exports", () => {
    const wasm = buildWasm({
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 0 }],
    });

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requiredExports: ["__abi_version", "kernel_host_adapter_manifest_ptr"],
    })).toEqual([
      "missing required exports: kernel_host_adapter_manifest_ptr",
    ]);
  });

  it("flags executable wasm missing the ABI and entrypoint exports", () => {
    const wasm = buildWasm({});

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requiredExports: ["__abi_version", "_start"],
    })).toEqual([
      "missing required exports: __abi_version, _start",
    ]);
  });

  it("does not require fork instrumentation for relocatable wasm objects", () => {
    const wasm = buildWasm({
      customSections: [{ name: "linking" }, { name: "reloc.CODE" }],
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });

    expect(readWasmCustomSectionNames(wasm)).toContain("linking");
    expect(wasmIsRelocatableObject(wasm)).toBe(true);
    expect(wasmImportsKernelFork(wasm)).toBe(true);
    expect(describeWasmArtifactPolicyFailures(wasm, { expectedAbi: 12 })).toEqual([]);
  });

  it("allows fork imports when an output explicitly disables fork instrumentation", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [{ name: "__abi_version", kind: 0, index: 1 }],
    });

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requireForkInstrumentation: false,
      forbidForkInstrumentation: true,
    })).toEqual([]);
  });

  it("rejects fork instrumentation when an output disables it", () => {
    const wasm = buildWasm({
      funcImports: [{ module: "kernel", name: "kernel_fork", typeIdx: 0 }],
      funcTypes: [0],
      funcBodies: [abiVersionBody(12)],
      exports: [
        { name: "__abi_version", kind: 0, index: 1 },
        { name: "wpk_fork_unwind_begin", kind: 0, index: 1 },
        { name: "wpk_fork_unwind_end", kind: 0, index: 1 },
        { name: "wpk_fork_rewind_begin", kind: 0, index: 1 },
        { name: "wpk_fork_rewind_end", kind: 0, index: 1 },
        { name: "wpk_fork_state", kind: 0, index: 1 },
      ],
    });

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: 12,
      requireForkInstrumentation: false,
      forbidForkInstrumentation: true,
    })).toContain(
      "contains ABI 12 wasm-fork-instrument metadata, imports, or exports",
    );
  });
});

const builtNodeBinary =
  tryResolveBinary("programs/spidermonkey-node.wasm") ??
  join(process.cwd(), "..", "packages/registry/spidermonkey-node/bin/node.wasm");

describe.skipIf(!existsSync(builtNodeBinary))("built node.wasm artifact policy", () => {
  it("uses the complete SpiderMonkey fork-instrumentation policy", () => {
    const bytes = readFileSync(builtNodeBinary);
    const wasm = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    expect(describeWasmArtifactPolicyFailures(wasm, {
      expectedAbi: ABI_VERSION,
    })).toEqual([]);
    expect(wasmContainsLegacyAsyncify(wasm)).toBe(false);
    expect(readWasmExportNames(wasm).filter((name) => name.startsWith("wpk_fork_"))).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Integration: cross-check against real cached binaries via wasm-objdump.
// Skipped when wasm-objdump or the cache is unavailable.
// ---------------------------------------------------------------------------

function hasWasmObjdump(): boolean {
  try {
    execFileSync("wasm-objdump", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function wasmObjdumpCanDecode(path: string): boolean {
  try {
    execFileSync("wasm-objdump", ["-j", "Global", "-x", path], {
      stdio: "ignore",
    });
    return true;
  } catch {
    // WHY: ABI 43 uses typed-reference and GC encodings that older WABT
    // releases reject before they can associate __heap_base with its export.
    // This optional parity probe must not mistake an obsolete external decoder
    // for an invalid artifact; the mandatory parser cases above still run.
    return false;
  }
}

function objdumpHeapBase(path: string): bigint | null {
  const out = execFileSync("wasm-objdump", ["-j", "Global", "-x", path], { encoding: "utf-8" });
  const m = out.match(/<__heap_base>\s*-\s*init\s+i(?:32|64)=(-?\d+)/);
  return m ? BigInt(m[1]) : null;
}

/**
 * Walk the package cache for any `*.wasm` file matching `name`. The cache
 * uses content-addressed directories like `programs/<pkg>-rev<N>-<arch>-<hash>/`.
 * Returns the first match by default-arch (wasm32) preference.
 */
function findCachedBinary(name: string, arch = "wasm32"): string | null {
  const cacheRoot = join(homedir(), ".cache/kandelo/programs");
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!dir.includes(`-${arch}-`)) continue;
    const candidate = join(cacheRoot, dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// This is optional cross-check coverage, not a package-index policy test.
// A concurrently edited source projection must skip the cached-binary probe
// without preventing the pure artifact-parser cases above from collecting.
let localDashBinary: string | null = null;
try {
  localDashBinary = tryResolveBinary("programs/dash.wasm");
} catch {
  localDashBinary = null;
}
const dashBinary = (localDashBinary && existsSync(localDashBinary))
  ? localDashBinary
  : findCachedBinary("dash.wasm");
const haveTooling =
  hasWasmObjdump()
  && !!dashBinary
  && existsSync(dashBinary)
  && wasmObjdumpCanDecode(dashBinary);

describe.skipIf(!haveTooling)("extractHeapBase against cached binaries", () => {
  it("matches wasm-objdump for dash.wasm", () => {
    const bytes = readFileSync(dashBinary!);
    const arr = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const ours = extractHeapBase(arr);
    const expected = objdumpHeapBase(dashBinary!);
    expect(ours).not.toBeNull();
    expect(ours).toBe(expected);
  });
});
