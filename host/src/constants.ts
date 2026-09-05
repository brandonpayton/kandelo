import {
  PROCESS_MEMORY_DEFAULT_MAX_PAGES,
  PROCESS_MEMORY_PAGES_PER_THREAD_SLOT,
  PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT,
  PROCESS_MEMORY_WASM_PAGE_SIZE,
  WPK_CHECKPOINT_PROCESS_IMPORT,
  WPK_FORK_CAPABILITIES_SECTION,
  WPK_FORK_CAPABILITIES_VERSION,
  WPK_FORK_CAP_KNOWN_MASK,
  WPK_FORK_CAP_REQUIRED_FLAGS,
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
  WPK_FORK_IMPORTED_GLOBALS_KNOWN_FLAGS,
  WPK_FORK_IMPORTED_GLOBALS_MAGIC,
  WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE,
  WPK_FORK_IMPORTED_GLOBALS_SECTION,
  WPK_FORK_IMPORTED_GLOBALS_VERSION,
  WPK_FORK_IMPORTED_TABLES_FLAG_TABLE64,
  WPK_FORK_IMPORTED_TABLES_HEADER_SIZE,
  WPK_FORK_IMPORTED_TABLES_KNOWN_FLAGS,
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
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128,
  WPK_FORK_MODULE_STATE_POINTER_WIDTHS,
  WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT,
  WPK_FORK_MODULE_STATE_RECORD_VERSION,
  WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
  WPK_FORK_PROCESS_IMPORT,
  WPK_FORK_REQUIRED_EXPORTS,
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_REQUIRED_TABLE_IMPORTS,
  WPK_FORK_STATIC_ROOT_CATALOG_EXPORT as FORK_STATIC_ROOT_CATALOG_EXPORT,
  WPK_FORK_STATIC_ROOT_CATALOG_HEADER_SIZE as FORK_STATIC_ROOT_CATALOG_HEADER_SIZE,
  WPK_FORK_STATIC_ROOT_CATALOG_MAGIC,
  WPK_FORK_STATIC_ROOT_CATALOG_SECTION as FORK_STATIC_ROOT_CATALOG_SECTION,
  WPK_FORK_STATIC_ROOT_CATALOG_VERSION as FORK_STATIC_ROOT_CATALOG_VERSION,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
  WPK_FORK_UNWIND_TAG_IMPORT_MODULE as FORK_UNWIND_TAG_IMPORT_MODULE,
  WPK_FORK_UNWIND_TAG_IMPORT_NAME as FORK_UNWIND_TAG_IMPORT_NAME,
  WPK_FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY as FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY,
  WPK_FORK_UNWIND_TRANSPORT_SECTION as FORK_UNWIND_TRANSPORT_SECTION,
  WPK_FORK_UNWIND_TRANSPORT_VERSION as FORK_UNWIND_TRANSPORT_VERSION,
} from "./generated/abi";

const FORK_STATIC_ROOT_CATALOG_MAGIC =
  Uint8Array.from(WPK_FORK_STATIC_ROOT_CATALOG_MAGIC);

/** WebAssembly page size (64 KiB) */
export const WASM_PAGE_SIZE = PROCESS_MEMORY_WASM_PAGE_SIZE;

export { CH_DATA_SIZE, CH_HEADER_SIZE, CH_TOTAL_SIZE } from "./generated/abi";

/** Default max pages for WebAssembly.Memory */
export const DEFAULT_MAX_PAGES = PROCESS_MEMORY_DEFAULT_MAX_PAGES;

/** Default process-worker admission input shared by Node and browser hosts. */
export const DEFAULT_MAX_WORKERS = 4;

/**
 * Pages allocated per pthread slot: TLS/control, fork-save/scratch,
 * syscall channel primary, and syscall channel spill.
 */
export const PAGES_PER_THREAD = PROCESS_MEMORY_PAGES_PER_THREAD_SLOT;
export const PAGES_PER_THREAD_SLOT = PROCESS_MEMORY_PAGES_PER_THREAD_SLOT;

/** Return true when bytes start with a WebAssembly module header. */
export function isWasmModuleBytes(programBytes: ArrayBuffer): boolean {
  const src = new Uint8Array(programBytes);
  return src.length >= 8 &&
    src[0] === 0x00 &&
    src[1] === 0x61 &&
    src[2] === 0x73 &&
    src[3] === 0x6d &&
    src[4] === 0x01 &&
    src[5] === 0x00 &&
    src[6] === 0x00 &&
    src[7] === 0x00;
}

/**
 * Read an unsigned LEB128 starting at `off`.
 * Returns [value, bytesConsumed].
 */
function readULEB128(buf: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0, pos = off;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos - off];
}

/**
 * Read a signed LEB128 (i32 const init expression). Returns [value, bytesConsumed].
 * Used for `i32.const` immediates in wasm globals. For our purposes, the value
 * is always a positive address < 2^31, but we sign-extend correctly anyway.
 */
function readSLEB128_i32(buf: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0, pos = off;
  let byte = 0;
  for (;;) {
    byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  // Sign-extend if the sign bit (0x40) of the last byte is set
  if (shift < 32 && (byte & 0x40) !== 0) {
    result |= ~0 << shift;
  }
  return [result, pos - off];
}

/**
 * Read a signed LEB128 (i64 const init expression). Returns [value, bytesConsumed].
 * Returns a bigint to avoid precision loss for wasm64 addresses.
 */
function readSLEB128_i64(buf: Uint8Array, off: number): [bigint, number] {
  let result = 0n, shift = 0n, pos = off;
  let byte = 0;
  for (;;) {
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) break;
  }
  if (shift < 64n && (byte & 0x40) !== 0) {
    result |= (~0n) << shift;
  }
  return [result, pos - off];
}

export interface WasmValueType {
  /**
   * Leading binary opcode. Fork ABI signatures only compare numeric pointer
   * types, but retaining the leading opcode keeps diagnostics deterministic
   * while the parser skips the complete GC/reference encoding.
   */
  code: number;
  /** Signed heap type for the multi-byte `ref`/`ref null`/`exact` forms. */
  heapType?: number;
  /** Whether a multi-byte reference uses the shared heap-type prefix. */
  shared: boolean;
}

interface ParsedWasmValueType extends WasmValueType {
  next: number;
}

function skipSignedLeb128(
  buf: Uint8Array,
  off: number,
  maxBytes: number,
  context: string,
): number {
  for (let count = 0; count < maxBytes; count++) {
    if (off >= buf.length) throw new Error(`${context} is truncated`);
    if ((buf[off++]! & 0x80) === 0) return off;
  }
  throw new Error(`${context} has an overlong LEB128 encoding`);
}

/**
 * Read one complete value/reference type.
 *
 * Concrete and exact references are multi-byte (`ref[ null] heaptype`), and
 * recursive GC modules can use them in function, table, and global types.
 * Treating every value type as one byte desynchronizes the artifact guard and
 * can make a valid ABI function appear to have an arbitrary signature.
 */
function readWasmValueType(
  buf: Uint8Array,
  off: number,
  context: string,
): ParsedWasmValueType {
  if (off >= buf.length) throw new Error(`${context} is truncated`);
  const code = buf[off++]!;
  switch (code) {
    case 0x7f: // i32
    case 0x7e: // i64
    case 0x7d: // f32
    case 0x7c: // f64
    case 0x7b: // v128
    case 0x75: // nocontref
    case 0x74: // noexnref
    case 0x73: // nofuncref
    case 0x72: // noexternref
    case 0x71: // nullref
    case 0x70: // funcref
    case 0x6f: // externref
    case 0x6e: // anyref
    case 0x6d: // eqref
    case 0x6c: // i31ref
    case 0x6b: // structref
    case 0x6a: // arrayref
    case 0x69: // exnref
    case 0x68: // contref
      return { code, shared: false, next: off };
    case 0x62: // exact heaptype
    case 0x63: // ref null heaptype
    case 0x64: { // ref heaptype
      // Shared abstract heap types add a prefix before the signed heap type.
      const shared = buf[off] === 0x65;
      if (shared) off++;
      const next = skipSignedLeb128(buf, off, 5, `${context} heap type`);
      const [heapType] = readSLEB128_i64(buf, off);
      return {
        code,
        heapType: Number(heapType),
        shared,
        next,
      };
    }
    default:
      throw new Error(
        `${context} has unknown value type 0x${code.toString(16)}`,
      );
  }
}

function readWasmStorageType(
  buf: Uint8Array,
  off: number,
  context: string,
): ParsedWasmValueType {
  if (buf[off] === 0x78 || buf[off] === 0x77) {
    return { code: buf[off]!, shared: false, next: off + 1 };
  }
  return readWasmValueType(buf, off, context);
}

function skipWasmBlockType(buf: Uint8Array, off: number): number {
  const first = buf[off];
  if (
    first === 0x40 || // empty
    first === 0x7f || // i32
    first === 0x7e || // i64
    first === 0x7d || // f32
    first === 0x7c || // f64
    first === 0x7b || // v128
    first === 0x70 || // funcref
    first === 0x6f    // externref
  ) {
    return off + 1;
  }
  const [, bytes] = readSLEB128_i32(buf, off);
  return off + bytes;
}

function readWasmFunctionType(
  src: Uint8Array,
  pos: number,
  context: string,
): { signature: WasmFunctionSignature; next: number } {
  const [paramCount, paramCountBytes] = readULEB128(src, pos);
  pos += paramCountBytes;
  const params: number[] = [];
  const paramTypes: WasmValueType[] = [];
  for (let index = 0; index < paramCount; index++) {
    const value = readWasmValueType(
      src,
      pos,
      `${context} parameter ${index}`,
    );
    params.push(value.code);
    paramTypes.push({
      code: value.code,
      heapType: value.heapType,
      shared: value.shared,
    });
    pos = value.next;
  }
  const [resultCount, resultCountBytes] = readULEB128(src, pos);
  pos += resultCountBytes;
  const results: number[] = [];
  const resultTypes: WasmValueType[] = [];
  for (let index = 0; index < resultCount; index++) {
    const value = readWasmValueType(
      src,
      pos,
      `${context} result ${index}`,
    );
    results.push(value.code);
    resultTypes.push({
      code: value.code,
      heapType: value.heapType,
      shared: value.shared,
    });
    pos = value.next;
  }
  return {
    signature: { params, results, paramTypes, resultTypes },
    next: pos,
  };
}

function readWasmFieldType(
  src: Uint8Array,
  pos: number,
  context: string,
): number {
  const storage = readWasmStorageType(src, pos, context);
  pos = storage.next;
  if (pos >= src.length) throw new Error(`${context} mutability is truncated`);
  const mutability = src[pos++]!;
  if (mutability !== 0 && mutability !== 1) {
    throw new Error(`${context} has invalid mutability ${mutability}`);
  }
  return pos;
}

function readWasmCompositeType(
  src: Uint8Array,
  opcode: number,
  pos: number,
  context: string,
): { signature?: WasmFunctionSignature; next: number } {
  if (opcode === 0x65) {
    if (pos >= src.length) throw new Error(`${context} shared type is truncated`);
    opcode = src[pos++]!;
  }
  // Descriptor types may prefix the actual composite type.
  for (const prefix of [0x4c, 0x4d]) {
    if (opcode !== prefix) continue;
    const [, indexBytes] = readULEB128(src, pos);
    pos += indexBytes;
    if (pos >= src.length) throw new Error(`${context} descriptor is truncated`);
    opcode = src[pos++]!;
  }

  if (opcode === 0x60) {
    return readWasmFunctionType(src, pos, context);
  }
  if (opcode === 0x5f) {
    const [fieldCount, fieldCountBytes] = readULEB128(src, pos);
    pos += fieldCountBytes;
    for (let index = 0; index < fieldCount; index++) {
      pos = readWasmFieldType(src, pos, `${context} field ${index}`);
    }
    return { next: pos };
  }
  if (opcode === 0x5e) {
    return {
      next: readWasmFieldType(src, pos, `${context} array field`),
    };
  }
  if (opcode === 0x5d) {
    return {
      next: skipSignedLeb128(src, pos, 5, `${context} continuation type`),
    };
  }
  throw new Error(
    `${context} has unknown composite type 0x${opcode.toString(16)}`,
  );
}

function readWasmSubtype(
  src: Uint8Array,
  pos: number,
  context: string,
): { signature?: WasmFunctionSignature; next: number } {
  if (pos >= src.length) throw new Error(`${context} is truncated`);
  let opcode = src[pos++]!;
  if (opcode === 0x4f || opcode === 0x50) {
    const [supertypeCount, countBytes] = readULEB128(src, pos);
    pos += countBytes;
    for (let index = 0; index < supertypeCount; index++) {
      const [, indexBytes] = readULEB128(src, pos);
      pos += indexBytes;
    }
    if (pos >= src.length) throw new Error(`${context} body is truncated`);
    opcode = src[pos++]!;
  }
  return readWasmCompositeType(src, opcode, pos, context);
}

function readWasmTypeSection(
  src: Uint8Array,
  pos: number,
): { types: Array<WasmFunctionSignature | undefined>; next: number } {
  const [groupCount, groupCountBytes] = readULEB128(src, pos);
  pos += groupCountBytes;
  const types: Array<WasmFunctionSignature | undefined> = [];
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
    if (src[pos] === 0x4e) {
      pos++;
      const [typeCount, typeCountBytes] = readULEB128(src, pos);
      pos += typeCountBytes;
      for (let typeIndex = 0; typeIndex < typeCount; typeIndex++) {
        const parsed = readWasmSubtype(
          src,
          pos,
          `recursive type ${groupIndex}:${typeIndex}`,
        );
        types.push(parsed.signature);
        pos = parsed.next;
      }
    } else {
      const parsed = readWasmSubtype(src, pos, `type ${groupIndex}`);
      types.push(parsed.signature);
      pos = parsed.next;
    }
  }
  return { types, next: pos };
}

function skipVectorMemarg(buf: Uint8Array, off: number): number {
  const [, alignBytes] = readULEB128(buf, off);
  off += alignBytes;
  const [, offsetBytes] = readULEB128(buf, off);
  return off + offsetBytes;
}

function skipPrefixedInstructionImmediate(prefix: number, buf: Uint8Array, off: number): number | null {
  const [subop, subopBytes] = readULEB128(buf, off);
  off += subopBytes;

  if (prefix === 0xfc) {
    switch (subop) {
      // saturating conversions
      case 0:
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
        return off;
      case 8: { // memory.init dataidx memidx
        const [, dataBytes] = readULEB128(buf, off);
        off += dataBytes;
        const [, memBytes] = readULEB128(buf, off);
        return off + memBytes;
      }
      case 9: { // data.drop dataidx
        const [, dataBytes] = readULEB128(buf, off);
        return off + dataBytes;
      }
      case 10: { // memory.copy dstmem srcmem
        const [, dstBytes] = readULEB128(buf, off);
        off += dstBytes;
        const [, srcBytes] = readULEB128(buf, off);
        return off + srcBytes;
      }
      case 11: { // memory.fill memidx
        const [, memBytes] = readULEB128(buf, off);
        return off + memBytes;
      }
      case 12: { // table.init elemidx tableidx
        const [, elemBytes] = readULEB128(buf, off);
        off += elemBytes;
        const [, tableBytes] = readULEB128(buf, off);
        return off + tableBytes;
      }
      case 13: { // elem.drop elemidx
        const [, elemBytes] = readULEB128(buf, off);
        return off + elemBytes;
      }
      case 14: { // table.copy dst src
        const [, dstBytes] = readULEB128(buf, off);
        off += dstBytes;
        const [, srcBytes] = readULEB128(buf, off);
        return off + srcBytes;
      }
      case 15:
      case 16:
      case 17: {
        // table.grow/table.size/table.fill tableidx
        const [, tableBytes] = readULEB128(buf, off);
        return off + tableBytes;
      }
      default:
        return null;
    }
  }

  if (prefix === 0xfd) {
    if (subop === 12 || subop === 13) return off + 16; // v128.const
    if (subop >= 21 && subop <= 34) return skipVectorMemarg(buf, off); // vector memory ops
    if (subop === 84) return off + 1; // i8x16.shuffle
    if (subop >= 92 && subop <= 99) return off + 1; // lane extraction/replacement
    if (subop >= 112 && subop <= 123) return off + 1;
    if (subop >= 124 && subop <= 131) return off + 1;
    if (subop >= 156 && subop <= 159) return off + 1;
    return off;
  }

  if (prefix === 0xfe) {
    if (subop === 0 || subop === 1) return skipVectorMemarg(buf, off); // memory.atomic.notify/wait32
    if (subop === 2) return skipVectorMemarg(buf, off); // memory.atomic.wait64
    if (subop === 3) return off; // atomic.fence
    if (subop >= 16 && subop <= 79) return skipVectorMemarg(buf, off);
    return null;
  }

  return null;
}

/**
 * Skip an import-section entry's payload at `pos`, returning the new position.
 * `numFuncImports` and `numGlobalImports` are incremented by reference if the
 * entry is a function or global import respectively (caller passes a holder).
 */
function skipImportEntry(
  src: Uint8Array,
  pos: number,
  counts: { funcImports: number; globalImports: number },
): number {
  // module name
  const [modLen, modLenBytes] = readULEB128(src, pos); pos += modLenBytes + modLen;
  // field name
  const [fieldLen, fieldLenBytes] = readULEB128(src, pos); pos += fieldLenBytes + fieldLen;
  const kind = src[pos++];
  if (kind === 0) {
    // function: type index
    counts.funcImports++;
    const [, n] = readULEB128(src, pos); pos += n;
  } else if (kind === 1) {
    // table: reftype + limits
    pos = readWasmValueType(src, pos, "table import type").next;
    pos = readLimits(src, pos).next;
  } else if (kind === 2) {
    // memory: limits
    pos = readLimits(src, pos).next;
  } else if (kind === 3) {
    // global: valtype + mutability
    counts.globalImports++;
    pos = readWasmValueType(src, pos, "global import type").next;
    pos++;
  } else if (kind === 4) {
    // exception tag: attribute byte + function type index
    pos++;
    const [, n] = readULEB128(src, pos); pos += n;
  }
  return pos;
}

function hasWasmMagic(src: Uint8Array): boolean {
  return src.length >= 8 &&
    src[0] === 0x00 &&
    src[1] === 0x61 &&
    src[2] === 0x73 &&
    src[3] === 0x6d;
}

function readName(src: Uint8Array, pos: number): [string, number] {
  const [len, lenBytes] = readULEB128(src, pos);
  pos += lenBytes;
  const name = new TextDecoder().decode(src.subarray(pos, pos + len));
  return [name, pos + len];
}

function containsAscii(src: Uint8Array, needle: string): boolean {
  if (needle.length === 0) return true;
  const bytes = new TextEncoder().encode(needle);
  outer:
  for (let i = 0; i <= src.length - bytes.length; i++) {
    for (let j = 0; j < bytes.length; j++) {
      if (src[i + j] !== bytes[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Export set produced by `wasm-fork-instrument`.
 *
 * Any program that can reach `kernel.kernel_fork` must export all of these so
 * the host can unwind the parent and rewind the child at the fork point.
 */
export const WPK_FORK_EXPORTS = WPK_FORK_REQUIRED_EXPORTS.map(({ name }) => name);

export interface WasmFunctionSignature {
  readonly params: readonly number[];
  readonly results: readonly number[];
  /** Complete binary value types, including concrete heap type and nullability. */
  readonly paramTypes: readonly WasmValueType[];
  /** Complete binary value types, including concrete heap type and nullability. */
  readonly resultTypes: readonly WasmValueType[];
}

export interface WasmFunctionImportType {
  readonly module: string;
  readonly name: string;
  /** Ordinal among every import-section entry, regardless of import kind. */
  readonly importOrdinal: number;
  /** Function index assigned by the core Wasm index space. */
  readonly functionIndex: number;
  readonly signature: WasmFunctionSignature;
}

interface WasmGlobalImportType {
  module: string;
  name: string;
  importOrdinal: number;
  index: number;
  valueType: number;
  recipeTypeCode: number | null;
  mutable: boolean;
  shared: boolean;
}

interface WasmTableType {
  elementType: number;
  table64: boolean;
  minimum: number;
  maximum: number | null;
}

interface WasmTableImportType extends WasmTableType {
  module: string;
  name: string;
  importOrdinal: number;
  index: number;
  recipeTypeCode: number | null;
}

interface WasmExportEntry {
  kind: number;
  index: number;
}

interface WasmForkArtifactFacts {
  functionTypes: readonly (WasmFunctionSignature | undefined)[];
  functionTypeIndices: readonly number[];
  functionImports: Map<string, WasmFunctionSignature[]>;
  functionImportEntries: WasmFunctionImportType[];
  globalImports: Map<string, WasmGlobalImportType[]>;
  tableImports: Map<string, WasmTableImportType[]>;
  tables: WasmTableType[];
  tagImports: Map<string, WasmFunctionSignature[]>;
  functionExports: Map<string, WasmFunctionSignature[]>;
  globalExports: Map<string, number[]>;
  tableExports: Map<string, number[]>;
  exports: Map<string, WasmExportEntry[]>;
  memoryPointerWidths: number[];
  forkCapabilities: Uint8Array[];
  linkedFrameDescriptors: Uint8Array[];
  exceptionCodecDescriptors: Uint8Array[];
  importedGlobalsDescriptors: Uint8Array[];
  importedTablesDescriptors: Uint8Array[];
  moduleStateDescriptors: Uint8Array[];
  staticRootDescriptors: Uint8Array[];
  unwindTransportDescriptors: Uint8Array[];
  nativeStartCount: number;
  importsKernelFork: boolean;
}

function forkGlobalRecipeTypeCode(
  valueType: ParsedWasmValueType,
  functionTypes: readonly (WasmFunctionSignature | undefined)[],
): number | null {
  switch (valueType.code) {
    case 0x7f:
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I32;
    case 0x7e:
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_I64;
    case 0x7d:
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F32;
    case 0x7c:
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_F64;
    case 0x7b:
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_V128;
    case 0x70: // funcref
    case 0x73: // nofuncref
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF;
    case 0x6f: // externref
    case 0x72: // noexternref
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF;
    case 0x69: // exnref
    case 0x74: // noexnref
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF;
    case 0x68: // contref
    case 0x6a: // arrayref
    case 0x6b: // structref
    case 0x6c: // i31ref
    case 0x6d: // eqref
    case 0x6e: // anyref
    case 0x71: // nullref
    case 0x75: // nocontref
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF;
    case 0x62: // exact heaptype
    case 0x63: // ref null heaptype
    case 0x64: { // ref heaptype
      const heapType = valueType.heapType;
      if (heapType === undefined) return null;
      if (heapType === -16 || heapType === -13) {
        return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF;
      }
      if (heapType === -17 || heapType === -14) {
        return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF;
      }
      if (heapType === -23 || heapType === -12) {
        return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF;
      }
      if (heapType >= 0 && functionTypes[heapType] !== undefined) {
        return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF;
      }
      return WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF;
    }
    default:
      return null;
  }
}

function appendSignature(
  signatures: Map<string, WasmFunctionSignature[]>,
  identity: string,
  signature: WasmFunctionSignature | undefined,
): void {
  if (!signature) {
    throw new Error(`function ${identity} refers to an unknown type`);
  }
  const values = signatures.get(identity) ?? [];
  values.push(signature);
  signatures.set(identity, values);
}

function appendImportType<T>(
  imports: Map<string, T[]>,
  identity: string,
  value: T,
): void {
  const values = imports.get(identity) ?? [];
  values.push(value);
  imports.set(identity, values);
}

function readLimits(
  src: Uint8Array,
  pos: number,
): {
  flags: number;
  minimum: number;
  maximum: number | null;
  next: number;
} {
  const [flags, flagBytes] = readULEB128(src, pos);
  pos += flagBytes;
  const [minimum, minBytes] = readULEB128(src, pos);
  pos += minBytes;
  let maximum: number | null = null;
  if ((flags & 1) !== 0) {
    const [value, maxBytes] = readULEB128(src, pos);
    pos += maxBytes;
    maximum = value;
  }
  return { flags, minimum, maximum, next: pos };
}

/**
 * Parse the portions of a final Wasm module that jointly define the ABI 43
 * fork-artifact contract.
 *
 * WHY: names alone can look complete while the host and guest disagree about
 * i32/i64 pointers. Release and resolver acceptance must validate the actual
 * memory architecture, descriptor, and function types as one atomic contract.
 */
function readWasmForkArtifactFacts(programBytes: ArrayBuffer): WasmForkArtifactFacts {
  const src = new Uint8Array(programBytes);
  if (!hasWasmMagic(src)) throw new Error("not a wasm binary");

  const functionTypes: Array<WasmFunctionSignature | undefined> = [];
  const functionTypeIndices: number[] = [];
  const pendingFunctionExports: Array<{ name: string; index: number }> = [];
  const facts: WasmForkArtifactFacts = {
    functionTypes,
    functionTypeIndices,
    functionImports: new Map(),
    functionImportEntries: [],
    globalImports: new Map(),
    tableImports: new Map(),
    tables: [],
    tagImports: new Map(),
    functionExports: new Map(),
    globalExports: new Map(),
    tableExports: new Map(),
    exports: new Map(),
    memoryPointerWidths: [],
    forkCapabilities: [],
    linkedFrameDescriptors: [],
    exceptionCodecDescriptors: [],
    importedGlobalsDescriptors: [],
    importedTablesDescriptors: [],
    moduleStateDescriptors: [],
    staticRootDescriptors: [],
    unwindTransportDescriptors: [],
    nativeStartCount: 0,
    importsKernelFork: false,
  };

  let globalImportCount = 0;
  let tableImportCount = 0;
  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;
    const sectionEnd = contentOffset + sectionSize;
    if (sectionEnd > src.length) throw new Error("wasm section exceeds file size");
    let pos = contentOffset;
    let requireFullyConsumed = false;

    if (sectionId === 0) {
      const [name, afterName] = readName(src, pos);
      if (name === WPK_FORK_LINKED_FRAME_FORMAT_SECTION) {
        facts.linkedFrameDescriptors.push(src.slice(afterName, sectionEnd));
      } else if (name === WPK_FORK_CAPABILITIES_SECTION) {
        facts.forkCapabilities.push(src.slice(afterName, sectionEnd));
      } else if (name === WPK_FORK_EXCEPTION_CODEC_SECTION) {
        facts.exceptionCodecDescriptors.push(src.slice(afterName, sectionEnd));
      } else if (name === WPK_FORK_IMPORTED_GLOBALS_SECTION) {
        facts.importedGlobalsDescriptors.push(src.slice(afterName, sectionEnd));
      } else if (name === WPK_FORK_IMPORTED_TABLES_SECTION) {
        facts.importedTablesDescriptors.push(src.slice(afterName, sectionEnd));
      } else if (name === WPK_FORK_MODULE_STATE_FORMAT_SECTION) {
        facts.moduleStateDescriptors.push(src.slice(afterName, sectionEnd));
      } else if (name === FORK_STATIC_ROOT_CATALOG_SECTION) {
        facts.staticRootDescriptors.push(src.slice(afterName, sectionEnd));
      } else if (name === FORK_UNWIND_TRANSPORT_SECTION) {
        facts.unwindTransportDescriptors.push(src.slice(afterName, sectionEnd));
      }
    } else if (sectionId === 1) {
      requireFullyConsumed = true;
      const parsed = readWasmTypeSection(src, pos);
      functionTypes.push(...parsed.types);
      pos = parsed.next;
    } else if (sectionId === 2) {
      requireFullyConsumed = true;
      const [count, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < count; i++) {
        const [moduleName, afterModule] = readName(src, pos);
        const [fieldName, afterField] = readName(src, afterModule);
        pos = afterField;
        const kind = src[pos++];
        if (kind === 0) {
          const [typeIndex, typeBytes] = readULEB128(src, pos);
          pos += typeBytes;
          const functionIndex = functionTypeIndices.length;
          functionTypeIndices.push(typeIndex);
          const identity = `${moduleName}.${fieldName}`;
          const signature = functionTypes[typeIndex];
          appendSignature(facts.functionImports, identity, signature);
          facts.functionImportEntries.push({
            module: moduleName,
            name: fieldName,
            importOrdinal: i,
            functionIndex,
            signature: signature!,
          });
          if (identity === "kernel.kernel_fork") facts.importsKernelFork = true;
        } else if (kind === 1) {
          const element = readWasmValueType(
            src,
            pos,
            `table import ${moduleName}.${fieldName}`,
          );
          pos = element.next;
          const limits = readLimits(src, pos);
          pos = limits.next;
          appendImportType(
            facts.tableImports,
            `${moduleName}.${fieldName}`,
            {
              module: moduleName,
              name: fieldName,
              importOrdinal: i,
              index: tableImportCount++,
              elementType: element.code,
              recipeTypeCode: forkGlobalRecipeTypeCode(
                element,
                functionTypes,
              ),
              table64: (limits.flags & 4) !== 0,
              minimum: limits.minimum,
              maximum: limits.maximum,
            },
          );
          facts.tables.push({
            elementType: element.code,
            table64: (limits.flags & 4) !== 0,
            minimum: limits.minimum,
            maximum: limits.maximum,
          });
        } else if (kind === 2) {
          const limits = readLimits(src, pos);
          pos = limits.next;
          facts.memoryPointerWidths.push((limits.flags & 4) !== 0 ? 8 : 4);
        } else if (kind === 3) {
          const valueType = readWasmValueType(
            src,
            pos,
            `global import ${moduleName}.${fieldName}`,
          );
          pos = valueType.next;
          if (pos >= src.length) {
            throw new Error(`global import ${moduleName}.${fieldName} is truncated`);
          }
          const flags = src[pos++]!;
          if ((flags & ~0b11) !== 0) {
            throw new Error(
              `global import ${moduleName}.${fieldName} has invalid flags ${flags}`,
            );
          }
          appendImportType(
            facts.globalImports,
            `${moduleName}.${fieldName}`,
            {
              module: moduleName,
              name: fieldName,
              importOrdinal: i,
              index: globalImportCount++,
              valueType: valueType.code,
              recipeTypeCode: forkGlobalRecipeTypeCode(
                valueType,
                functionTypes,
              ),
              mutable: (flags & 0b01) !== 0,
              shared: (flags & 0b10) !== 0,
            },
          );
        } else if (kind === 4) {
          const attribute = src[pos++];
          if (attribute !== 0) {
            throw new Error(`unsupported wasm tag attribute ${attribute}`);
          }
          const [typeIndex, typeBytes] = readULEB128(src, pos);
          pos += typeBytes;
          appendSignature(
            facts.tagImports,
            `${moduleName}.${fieldName}`,
            functionTypes[typeIndex],
          );
        } else {
          throw new Error(`unsupported wasm import kind ${kind}`);
        }
      }
    } else if (sectionId === 3) {
      requireFullyConsumed = true;
      const [count, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < count; i++) {
        const [typeIndex, typeBytes] = readULEB128(src, pos);
        pos += typeBytes;
        functionTypeIndices.push(typeIndex);
      }
    } else if (sectionId === 4) {
      requireFullyConsumed = true;
      const [count, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let index = 0; index < count; index++) {
        const element = readWasmValueType(
          src,
          pos,
          `defined table ${index}`,
        );
        pos = element.next;
        const limits = readLimits(src, pos);
        pos = limits.next;
        facts.tables.push({
          elementType: element.code,
          table64: (limits.flags & 4) !== 0,
          minimum: limits.minimum,
          maximum: limits.maximum,
        });
      }
    } else if (sectionId === 5) {
      requireFullyConsumed = true;
      const [count, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < count; i++) {
        const limits = readLimits(src, pos);
        pos = limits.next;
        facts.memoryPointerWidths.push((limits.flags & 4) !== 0 ? 8 : 4);
      }
    } else if (sectionId === 7) {
      requireFullyConsumed = true;
      const [count, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < count; i++) {
        const [name, afterName] = readName(src, pos);
        pos = afterName;
        const kind = src[pos++];
        const [index, indexBytes] = readULEB128(src, pos);
        pos += indexBytes;
        appendImportType(facts.exports, name, { kind, index });
        if (kind === 0) {
          pendingFunctionExports.push({ name, index });
        } else if (kind === 3) {
          appendImportType(facts.globalExports, name, index);
        } else if (kind === 1) {
          appendImportType(facts.tableExports, name, index);
        }
      }
    } else if (sectionId === 8) {
      requireFullyConsumed = true;
      facts.nativeStartCount++;
      const [, functionIndexBytes] = readULEB128(src, pos);
      pos += functionIndexBytes;
    }

    if (requireFullyConsumed && pos !== sectionEnd) {
      throw new Error(`malformed wasm section ${sectionId}`);
    }
    offset = sectionEnd;
  }

  for (const { name, index } of pendingFunctionExports) {
    const typeIndex = functionTypeIndices[index];
    appendSignature(facts.functionExports, name, functionTypes[typeIndex]);
  }
  return facts;
}

function validateLinkedFrameDescriptor(descriptor: Uint8Array): number {
  if (descriptor.byteLength !== WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE) {
    throw new Error(
      `linked-frame descriptor has ${descriptor.byteLength} bytes, expected ${WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE}`,
    );
  }
  if (!WPK_FORK_LINKED_FRAME_FORMAT_MAGIC.every((byte, index) => descriptor[index] === byte)) {
    throw new Error("linked-frame descriptor has invalid magic");
  }
  const view = new DataView(
    descriptor.buffer,
    descriptor.byteOffset,
    descriptor.byteLength,
  );
  const version = view.getUint16(4, true);
  if (version !== WPK_FORK_LINKED_FRAME_FORMAT_VERSION) {
    throw new Error(`linked-frame descriptor version ${version} is unsupported`);
  }
  const declaredSize = view.getUint16(6, true);
  if (declaredSize !== WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE) {
    throw new Error(
      `linked-frame descriptor declares size ${declaredSize}, expected ${WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE}`,
    );
  }
  const pointerWidth = view.getUint8(8);
  const pointerFormat = WPK_FORK_LINKED_FRAME_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === pointerWidth,
  );
  if (!pointerFormat) {
    throw new Error(`linked-frame descriptor pointer width ${pointerWidth} is unsupported`);
  }
  if (view.getUint8(9) !== WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT) {
    throw new Error(
      `linked-frame descriptor alignment ${view.getUint8(9)} is unsupported`,
    );
  }
  const flags = view.getUint16(10, true);
  if (flags !== WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS) {
    throw new Error(
      `linked-frame descriptor flags 0x${flags.toString(16)} do not equal required flags 0x${WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS.toString(16)}`,
    );
  }
  if (
    view.getUint32(12, true) !== pointerFormat.chunkHeaderSize ||
    view.getUint32(16, true) !== pointerFormat.nodeHeaderSize
  ) {
    throw new Error(
      `linked-frame descriptor header sizes do not match its ${pointerWidth}-byte pointer width`,
    );
  }
  return pointerFormat.bytes;
}

function validateForkCapabilities(sections: Uint8Array[]): string[] {
  if (sections.length === 0) {
    return [`missing required ${WPK_FORK_CAPABILITIES_SECTION} capability`];
  }
  if (sections.length !== 1) {
    return [
      `has ${sections.length} ${WPK_FORK_CAPABILITIES_SECTION} sections, expected exactly one`,
    ];
  }
  const capability = sections[0];
  if (capability.byteLength !== 2) {
    return [
      `${WPK_FORK_CAPABILITIES_SECTION} has ${capability.byteLength} bytes, expected 2`,
    ];
  }
  if (capability[0] !== WPK_FORK_CAPABILITIES_VERSION) {
    return [
      `${WPK_FORK_CAPABILITIES_SECTION} version ${capability[0]} is unsupported`,
    ];
  }
  const flags = capability[1]!;
  if ((flags & ~WPK_FORK_CAP_KNOWN_MASK) !== 0) {
    return [
      `${WPK_FORK_CAPABILITIES_SECTION} has unknown flags 0x${flags.toString(16)}`,
    ];
  }
  if ((flags & WPK_FORK_CAP_REQUIRED_FLAGS) !== WPK_FORK_CAP_REQUIRED_FLAGS) {
    return [
      `${WPK_FORK_CAPABILITIES_SECTION} flags 0x${flags.toString(16)} omit required activation-state safety flags 0x${WPK_FORK_CAP_REQUIRED_FLAGS.toString(16)}`,
    ];
  }
  return [];
}

function validateForkUnwindTransport(facts: WasmForkArtifactFacts): string[] {
  const failures: string[] = [];
  const identity = `${FORK_UNWIND_TAG_IMPORT_MODULE}.${FORK_UNWIND_TAG_IMPORT_NAME}`;
  const tags = facts.tagImports.get(identity);
  if (!tags) {
    failures.push(`missing required private fork-unwind tag import ${identity}`);
  } else if (tags.length !== 1) {
    failures.push(`duplicate private fork-unwind tag import ${identity}`);
  } else if (tags[0]!.params.length !== 0 || tags[0]!.results.length !== 0) {
    failures.push(`private fork-unwind tag ${identity} must have an empty payload`);
  }

  if (facts.unwindTransportDescriptors.length === 0) {
    failures.push(`missing required ${FORK_UNWIND_TRANSPORT_SECTION} descriptor`);
  } else if (facts.unwindTransportDescriptors.length !== 1) {
    failures.push(
      `has ${facts.unwindTransportDescriptors.length} ${FORK_UNWIND_TRANSPORT_SECTION} descriptors, expected exactly one`,
    );
  } else {
    const descriptor = facts.unwindTransportDescriptors[0]!;
    if (
      descriptor.length !== 2
      || descriptor[0] !== FORK_UNWIND_TRANSPORT_VERSION
      || descriptor[1] !== FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY
    ) {
      failures.push(
        `${FORK_UNWIND_TRANSPORT_SECTION} must be [${
          FORK_UNWIND_TRANSPORT_VERSION
        }, ${FORK_UNWIND_TRANSPORT_PAYLOAD_ARITY}]`,
      );
    }
  }
  return failures;
}

function validateForkModuleStateDescriptor(
  descriptors: readonly Uint8Array[],
  expectedPointerWidth: number | null,
): string[] {
  if (descriptors.length === 0) {
    return [`missing required ${WPK_FORK_MODULE_STATE_FORMAT_SECTION} descriptor`];
  }
  if (descriptors.length !== 1) {
    return [
      `has ${descriptors.length} ${WPK_FORK_MODULE_STATE_FORMAT_SECTION} descriptors, expected exactly one`,
    ];
  }
  const bytes = descriptors[0]!;
  if (bytes.byteLength !== WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE) {
    return [
      `${WPK_FORK_MODULE_STATE_FORMAT_SECTION} has ${bytes.byteLength} bytes, expected ${WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE}`,
    ];
  }
  if (!WPK_FORK_MODULE_STATE_FORMAT_MAGIC.every((byte, index) => bytes[index] === byte)) {
    return [`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} has invalid magic`];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const declaredSize = view.getUint16(6, true);
  const pointerWidth = view.getUint8(8);
  const pointerFormat = WPK_FORK_MODULE_STATE_POINTER_WIDTHS.find(
    ({ bytes }) => bytes === pointerWidth,
  );
  const alignment = view.getUint8(9);
  const flags = view.getUint16(10, true);
  const arenaVersion = view.getUint16(12, true);
  const recordVersion = view.getUint16(14, true);
  const rootWord = view.getUint32(16, true);
  const reserved = view.getUint32(20, true);
  const failures: string[] = [];
  if (version !== WPK_FORK_MODULE_STATE_FORMAT_VERSION) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} version ${version} is unsupported`);
  }
  if (declaredSize !== WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} declares size ${declaredSize}`);
  }
  if (!pointerFormat) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} pointer width ${pointerWidth} is unsupported`);
  } else if (expectedPointerWidth !== null && pointerWidth !== expectedPointerWidth) {
    failures.push(
      `${WPK_FORK_MODULE_STATE_FORMAT_SECTION} pointer width ${pointerWidth} does not match linked frames ${expectedPointerWidth}`,
    );
  }
  if (alignment !== WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} alignment ${alignment} is unsupported`);
  }
  if (flags !== WPK_FORK_MODULE_STATE_REQUIRED_FLAGS) {
    failures.push(
      `${WPK_FORK_MODULE_STATE_FORMAT_SECTION} flags 0x${flags.toString(16)} do not equal required flags 0x${WPK_FORK_MODULE_STATE_REQUIRED_FLAGS.toString(16)}`,
    );
  }
  if (arenaVersion !== WPK_FORK_MODULE_STATE_ARENA_VERSION) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} arena version ${arenaVersion} is unsupported`);
  }
  if (recordVersion !== WPK_FORK_MODULE_STATE_RECORD_VERSION) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} record version ${recordVersion} is unsupported`);
  }
  if (rootWord !== WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} root word ${rootWord} is unsupported`);
  }
  if (reserved !== 0) {
    failures.push(`${WPK_FORK_MODULE_STATE_FORMAT_SECTION} reserved field is nonzero`);
  }
  return failures;
}

function validateForkExceptionCodecDescriptor(
  descriptors: readonly Uint8Array[],
): string[] {
  if (descriptors.length === 0) {
    return [`missing required ${WPK_FORK_EXCEPTION_CODEC_SECTION} descriptor`];
  }
  if (descriptors.length !== 1) {
    return [
      `has ${descriptors.length} ${WPK_FORK_EXCEPTION_CODEC_SECTION} descriptors, expected exactly one`,
    ];
  }
  const bytes = descriptors[0]!;
  if (bytes.byteLength < WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE) {
    return [`${WPK_FORK_EXCEPTION_CODEC_SECTION} descriptor is truncated`];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const failures: string[] = [];
  if (view.getUint8(0) !== WPK_FORK_EXCEPTION_CODEC_VERSION) {
    failures.push(
      `${WPK_FORK_EXCEPTION_CODEC_SECTION} version ${view.getUint8(0)} is unsupported`,
    );
  }
  if (view.getUint8(1) !== 0 || view.getUint16(2, true) !== 0) {
    failures.push(`${WPK_FORK_EXCEPTION_CODEC_SECTION} reserved fields are nonzero`);
  }
  const count = view.getUint32(4, true);
  const expectedSize = WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE
    + count * WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;
  if (!Number.isSafeInteger(expectedSize) || bytes.byteLength !== expectedSize) {
    failures.push(
      `${WPK_FORK_EXCEPTION_CODEC_SECTION} has ${bytes.byteLength} bytes, expected ${expectedSize}`,
    );
    return failures;
  }

  const layouts = new Set<number>();
  for (let index = 0; index < count; index++) {
    const offset = WPK_FORK_EXCEPTION_CODEC_HEADER_SIZE
      + index * WPK_FORK_EXCEPTION_CODEC_TAG_RECORD_SIZE;
    const ordinal = view.getUint32(offset, true);
    const layoutId = view.getUint32(offset + 4, true);
    if (ordinal !== index) {
      failures.push(
        `${WPK_FORK_EXCEPTION_CODEC_SECTION} tag ordinal ${ordinal} is noncanonical at ${index}`,
      );
    }
    if (layoutId > 0x7fff_ffff || layouts.has(layoutId)) {
      failures.push(
        `${WPK_FORK_EXCEPTION_CODEC_SECTION} layout id ${layoutId} is invalid or duplicated`,
      );
    }
    layouts.add(layoutId);
    // The remaining u32 fields are deliberately shape-neutral byte/reference
    // counts. Any tag payload is legal when the instrumenter can emit its
    // recursive reference recipe; the guard validates format, not user shape.
  }
  return failures;
}

const FORK_IMPORTED_GLOBAL_TYPE_CODES = new Set<number>([
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

interface ForkImportedGlobalRecord {
  ownerId: number;
  typeCode: number;
  flags: number;
  importOrdinal: number;
  module: string;
  name: string;
}

function importedGlobalNeedsRecipe(global: WasmGlobalImportType): boolean {
  return !(
    global.module === WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE
    && (
      global.name === WPK_FORK_EXCEPTION_IMPORT_ACTIVATION
      || global.name === "__channel_base"
      // This immutable control address is reconstructed by each host Worker
      // from the ABI-defined process channel layout. It is not guest module
      // state and must not be serialized as an imported-global recipe.
      || global.name === "__wpk_fork_module_state_table_generation_addr"
    )
  );
}

function validateForkImportedGlobalsDescriptor(
  facts: WasmForkArtifactFacts,
): string[] {
  const descriptors = facts.importedGlobalsDescriptors;
  if (descriptors.length === 0) {
    return [`missing required ${WPK_FORK_IMPORTED_GLOBALS_SECTION} descriptor`];
  }
  if (descriptors.length !== 1) {
    return [
      `has ${descriptors.length} ${WPK_FORK_IMPORTED_GLOBALS_SECTION} descriptors, expected exactly one`,
    ];
  }
  const bytes = descriptors[0]!;
  if (bytes.byteLength < WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE) {
    return [`${WPK_FORK_IMPORTED_GLOBALS_SECTION} descriptor is truncated`];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const failures: string[] = [];
  if (!WPK_FORK_IMPORTED_GLOBALS_MAGIC.every((byte, index) => bytes[index] === byte)) {
    failures.push(`${WPK_FORK_IMPORTED_GLOBALS_SECTION} has invalid magic`);
  }
  if (view.getUint16(4, true) !== WPK_FORK_IMPORTED_GLOBALS_VERSION) {
    failures.push(
      `${WPK_FORK_IMPORTED_GLOBALS_SECTION} version ${view.getUint16(4, true)} is unsupported`,
    );
  }
  if (view.getUint16(6, true) !== WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE) {
    failures.push(`${WPK_FORK_IMPORTED_GLOBALS_SECTION} declares an invalid header size`);
  }
  const count = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) {
    failures.push(`${WPK_FORK_IMPORTED_GLOBALS_SECTION} reserved field is nonzero`);
  }

  const owners = new Set<number>();
  const importOrdinals = new Set<number>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: ForkImportedGlobalRecord[] = [];
  let previousImportOrdinal = -1;
  let offset = WPK_FORK_IMPORTED_GLOBALS_HEADER_SIZE;
  for (let index = 0; index < count; index++) {
    if (offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE > bytes.byteLength) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} header is truncated`,
      );
      return failures;
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
      !Number.isSafeInteger(expectedSize)
      || recordSize !== expectedSize
      || recordSize < WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE
      || offset + recordSize > bytes.byteLength
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} has invalid bounds`,
      );
      return failures;
    }
    if (ownerId === 0 || owners.has(ownerId)) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} has invalid or duplicated owner ${ownerId}`,
      );
    }
    owners.add(ownerId);
    if (!FORK_IMPORTED_GLOBAL_TYPE_CODES.has(typeCode)) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} has unknown value type ${typeCode}`,
      );
    }
    if ((flags & ~WPK_FORK_IMPORTED_GLOBALS_KNOWN_FLAGS) !== 0) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} has unknown flags 0x${flags.toString(16)}`,
      );
    }
    if (view.getUint16(offset + 10, true) !== 0) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} reserved fields are nonzero`,
      );
    }
    if (
      importOrdinals.has(importOrdinal)
      || importOrdinal <= previousImportOrdinal
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} has duplicated or unordered import ordinal`,
      );
    }
    importOrdinals.add(importOrdinal);
    previousImportOrdinal = importOrdinal;
    const namesOffset = offset + WPK_FORK_IMPORTED_GLOBALS_RECORD_HEADER_SIZE;
    try {
      const module = decoder.decode(
        bytes.subarray(namesOffset, namesOffset + moduleLength),
      );
      const name = decoder.decode(
        bytes.subarray(
          namesOffset + moduleLength,
          namesOffset + moduleLength + nameLength,
        ),
      );
      records.push({
        ownerId,
        typeCode,
        flags,
        importOrdinal,
        module,
        name,
      });
    } catch {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} record ${index} contains invalid UTF-8`,
      );
    }
    offset += recordSize;
  }
  if (offset !== bytes.byteLength) {
    failures.push(`${WPK_FORK_IMPORTED_GLOBALS_SECTION} has trailing bytes`);
  }

  const globalImports = [...facts.globalImports.values()].flat();
  const globalImportsByIndex = new Map(
    globalImports.map((global) => [global.index, global]),
  );
  const matchedImportIndices = new Set<number>();
  for (const record of records) {
    const catalogName =
      `${WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX}${record.ownerId}`;
    const catalog = facts.exports.get(catalogName);
    if (!catalog || catalog.length !== 1 || catalog[0]!.kind !== 3) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} owner ${record.ownerId} lacks exactly one global catalog export ${catalogName}`,
      );
      continue;
    }
    const imported = globalImportsByIndex.get(catalog[0]!.index);
    if (!imported || !importedGlobalNeedsRecipe(imported)) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} owner ${record.ownerId} does not identify a reconstructible imported global`,
      );
      continue;
    }
    if (
      imported.module !== record.module
      || imported.name !== record.name
      || imported.importOrdinal !== record.importOrdinal
      || imported.recipeTypeCode !== record.typeCode
      || imported.mutable !==
        ((record.flags & WPK_FORK_IMPORTED_GLOBALS_FLAG_MUTABLE) !== 0)
      || imported.shared !==
        ((record.flags & WPK_FORK_IMPORTED_GLOBALS_FLAG_SHARED) !== 0)
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} owner ${record.ownerId} does not match its imported global declaration`,
      );
      continue;
    }
    if (matchedImportIndices.has(imported.index)) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} repeats imported global index ${imported.index}`,
      );
      continue;
    }
    matchedImportIndices.add(imported.index);
  }

  for (const imported of globalImports) {
    if (
      importedGlobalNeedsRecipe(imported)
      && !matchedImportIndices.has(imported.index)
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_GLOBALS_SECTION} omits imported global ` +
          `${imported.module}.${imported.name} at index ${imported.index}`,
      );
    }
  }

  for (const [name, exports] of facts.exports) {
    if (!name.startsWith(WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX)) continue;
    const suffix = name.slice(WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX.length);
    const owner = Number(suffix);
    if (
      !/^[1-9][0-9]*$/.test(suffix)
      || !Number.isSafeInteger(owner)
      || owner > 0xffff_ffff
      || exports.length !== 1
      || exports[0]!.kind !== 3
    ) {
      failures.push(`malformed reserved fork global catalog export ${name}`);
    }
  }
  return failures;
}

const FORK_IMPORTED_TABLE_TYPE_CODES = new Set<number>([
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_FUNCREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXTERNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_EXNREF,
  WPK_FORK_MODULE_STATE_GLOBAL_TYPE_ANYREF,
]);

interface ForkImportedTableRecord {
  ownerId: number;
  typeCode: number;
  flags: number;
  importOrdinal: number;
  module: string;
  name: string;
}

function importedTableNeedsRecipe(table: WasmTableImportType): boolean {
  return !WPK_FORK_REQUIRED_TABLE_IMPORTS.some(
    ({ module, name }) => table.module === module && table.name === name,
  );
}

/**
 * Validate the pre-instantiation table-identity recipe one declaration at a
 * time.
 *
 * WHY: the same import-object property may feed several Wasm table imports,
 * and an imported table may be shared by several module activations. Names
 * alone cannot prove which declaration owns which catalog export; the full
 * import ordinal and exact table index make that identity deterministic before
 * any child continuation executes.
 */
function validateForkImportedTablesDescriptor(
  facts: WasmForkArtifactFacts,
): string[] {
  const descriptors = facts.importedTablesDescriptors;
  if (descriptors.length === 0) {
    return [`missing required ${WPK_FORK_IMPORTED_TABLES_SECTION} descriptor`];
  }
  if (descriptors.length !== 1) {
    return [
      `has ${descriptors.length} ${WPK_FORK_IMPORTED_TABLES_SECTION} descriptors, expected exactly one`,
    ];
  }
  const bytes = descriptors[0]!;
  if (bytes.byteLength < WPK_FORK_IMPORTED_TABLES_HEADER_SIZE) {
    return [`${WPK_FORK_IMPORTED_TABLES_SECTION} descriptor is truncated`];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const failures: string[] = [];
  if (!WPK_FORK_IMPORTED_TABLES_MAGIC.every((byte, index) => bytes[index] === byte)) {
    failures.push(`${WPK_FORK_IMPORTED_TABLES_SECTION} has invalid magic`);
  }
  if (view.getUint16(4, true) !== WPK_FORK_IMPORTED_TABLES_VERSION) {
    failures.push(
      `${WPK_FORK_IMPORTED_TABLES_SECTION} version ${view.getUint16(4, true)} is unsupported`,
    );
  }
  if (view.getUint16(6, true) !== WPK_FORK_IMPORTED_TABLES_HEADER_SIZE) {
    failures.push(`${WPK_FORK_IMPORTED_TABLES_SECTION} declares an invalid header size`);
  }
  const count = view.getUint32(8, true);
  if (view.getUint32(12, true) !== 0) {
    failures.push(`${WPK_FORK_IMPORTED_TABLES_SECTION} reserved field is nonzero`);
  }

  const owners = new Set<number>();
  const importOrdinals = new Set<number>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: ForkImportedTableRecord[] = [];
  let previousImportOrdinal = -1;
  let offset = WPK_FORK_IMPORTED_TABLES_HEADER_SIZE;
  for (let index = 0; index < count; index++) {
    if (offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE > bytes.byteLength) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} header is truncated`,
      );
      return failures;
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
      !Number.isSafeInteger(expectedSize)
      || recordSize !== expectedSize
      || recordSize < WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE
      || offset + recordSize > bytes.byteLength
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} has invalid bounds`,
      );
      return failures;
    }
    if (ownerId === 0 || owners.has(ownerId)) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} has invalid or duplicated owner ${ownerId}`,
      );
    }
    owners.add(ownerId);
    if (!FORK_IMPORTED_TABLE_TYPE_CODES.has(typeCode)) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} has unknown element type ${typeCode}`,
      );
    }
    if ((flags & ~WPK_FORK_IMPORTED_TABLES_KNOWN_FLAGS) !== 0) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} has unknown flags 0x${flags.toString(16)}`,
      );
    }
    if (view.getUint16(offset + 10, true) !== 0) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} reserved fields are nonzero`,
      );
    }
    if (
      importOrdinals.has(importOrdinal)
      || importOrdinal <= previousImportOrdinal
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} has duplicated or unordered import ordinal`,
      );
    }
    importOrdinals.add(importOrdinal);
    previousImportOrdinal = importOrdinal;
    const namesOffset = offset + WPK_FORK_IMPORTED_TABLES_RECORD_HEADER_SIZE;
    try {
      const module = decoder.decode(
        bytes.subarray(namesOffset, namesOffset + moduleLength),
      );
      const name = decoder.decode(
        bytes.subarray(
          namesOffset + moduleLength,
          namesOffset + moduleLength + nameLength,
        ),
      );
      records.push({
        ownerId,
        typeCode,
        flags,
        importOrdinal,
        module,
        name,
      });
    } catch {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} record ${index} contains invalid UTF-8`,
      );
    }
    offset += recordSize;
  }
  if (offset !== bytes.byteLength) {
    failures.push(`${WPK_FORK_IMPORTED_TABLES_SECTION} has trailing bytes`);
  }

  const tableImports = [...facts.tableImports.values()].flat();
  const tableImportsByIndex = new Map(
    tableImports.map((table) => [table.index, table]),
  );
  const matchedImportIndices = new Set<number>();
  for (const record of records) {
    const catalogName =
      `${WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX}${record.ownerId}`;
    const catalog = facts.exports.get(catalogName);
    if (!catalog || catalog.length !== 1 || catalog[0]!.kind !== 1) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} owner ${record.ownerId} lacks exactly one table catalog export ${catalogName}`,
      );
      continue;
    }
    const imported = tableImportsByIndex.get(catalog[0]!.index);
    if (!imported || !importedTableNeedsRecipe(imported)) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} owner ${record.ownerId} does not identify a reconstructible imported table`,
      );
      continue;
    }
    if (
      imported.module !== record.module
      || imported.name !== record.name
      || imported.importOrdinal !== record.importOrdinal
      || imported.recipeTypeCode !== record.typeCode
      || imported.table64 !==
        ((record.flags & WPK_FORK_IMPORTED_TABLES_FLAG_TABLE64) !== 0)
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} owner ${record.ownerId} does not match its imported table declaration`,
      );
      continue;
    }
    if (matchedImportIndices.has(imported.index)) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} repeats imported table index ${imported.index}`,
      );
      continue;
    }
    matchedImportIndices.add(imported.index);
  }

  for (const imported of tableImports) {
    if (
      importedTableNeedsRecipe(imported)
      && !matchedImportIndices.has(imported.index)
    ) {
      failures.push(
        `${WPK_FORK_IMPORTED_TABLES_SECTION} omits imported table ` +
          `${imported.module}.${imported.name} at index ${imported.index}`,
      );
    }
  }

  for (const [name, exports] of facts.exports) {
    if (!name.startsWith(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX)) continue;
    const suffix = name.slice(WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX.length);
    const owner = Number(suffix);
    if (
      !/^[1-9][0-9]*$/.test(suffix)
      || !Number.isSafeInteger(owner)
      || owner > 0xffff_ffff
      || exports.length !== 1
      || exports[0]!.kind !== 1
    ) {
      failures.push(`malformed reserved fork table catalog export ${name}`);
    }
  }
  return failures;
}

type ForkAbiValueType =
  | "ptr"
  | "i32"
  | "i64"
  | "anyref"
  | "exnref"
  | "externref"
  | "funcref";

function expectedWasmValueType(
  value: ForkAbiValueType,
  pointerWidth: number,
): number {
  switch (value) {
    case "ptr":
      return pointerWidth === 8 ? 0x7e : 0x7f;
    case "i32":
      return 0x7f;
    case "i64":
      return 0x7e;
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

function signatureMatches(
  actual: WasmFunctionSignature,
  params: readonly ForkAbiValueType[],
  results: readonly ForkAbiValueType[],
  pointerWidth: number,
): boolean {
  return actual.params.length === params.length &&
    actual.results.length === results.length &&
    actual.params.every((value, index) =>
      value === expectedWasmValueType(params[index], pointerWidth)
    ) &&
    actual.results.every((value, index) =>
      value === expectedWasmValueType(results[index], pointerWidth)
    );
}

function signatureText(
  params: readonly ForkAbiValueType[],
  results: readonly ForkAbiValueType[],
  pointerWidth: number,
): string {
  const render = (value: ForkAbiValueType) =>
    value === "ptr" ? (pointerWidth === 8 ? "i64" : "i32") : value;
  return `(${params.map(render).join(", ")}) -> (${results.map(render).join(", ")})`;
}

function validateForkActivationImport(facts: WasmForkArtifactFacts): string[] {
  const identity =
    `${WPK_FORK_EXCEPTION_CODEC_IMPORT_MODULE}.${WPK_FORK_EXCEPTION_IMPORT_ACTIVATION}`;
  const imports = facts.globalImports.get(identity);
  if (!imports) {
    return [`missing required immutable exception-codec activation import ${identity}`];
  }
  if (imports.length !== 1) {
    return [`duplicate exception-codec activation import ${identity}`];
  }
  if (imports[0]!.valueType !== 0x7f || imports[0]!.mutable) {
    return [`exception-codec activation import ${identity} must be immutable i32`];
  }
  return [];
}

function validateForkTableImports(facts: WasmForkArtifactFacts): string[] {
  const failures: string[] = [];
  for (const requirement of WPK_FORK_REQUIRED_TABLE_IMPORTS) {
    const identity = `${requirement.module}.${requirement.name}`;
    const imports = facts.tableImports.get(identity);
    if (!imports) {
      failures.push(`missing required ABI 43 fork-runtime table import ${identity}`);
      continue;
    }
    if (imports.length !== 1) {
      failures.push(`duplicate ABI 43 fork-runtime table import ${identity}`);
      continue;
    }
    const actual = imports[0]!;
    const expectedElement = expectedWasmValueType(requirement.element, 4);
    if (
      actual.elementType !== expectedElement
      || actual.table64 !== requirement.table64
      || actual.minimum !== requirement.minimum
      || actual.maximum !== requirement.maximum
    ) {
      failures.push(
        `ABI 43 fork-runtime table import ${identity} has the wrong type or limits`,
      );
    }
  }
  return failures;
}

function validateForkStaticRootCatalog(
  facts: WasmForkArtifactFacts,
): string[] {
  if (facts.staticRootDescriptors.length === 0) {
    return [`missing required ${FORK_STATIC_ROOT_CATALOG_SECTION} descriptor`];
  }
  if (facts.staticRootDescriptors.length !== 1) {
    return [
      `has ${facts.staticRootDescriptors.length} ${FORK_STATIC_ROOT_CATALOG_SECTION} descriptors, expected exactly one`,
    ];
  }
  const descriptor = facts.staticRootDescriptors[0]!;
  if (descriptor.byteLength !== FORK_STATIC_ROOT_CATALOG_HEADER_SIZE) {
    return [
      `${FORK_STATIC_ROOT_CATALOG_SECTION} has ${descriptor.byteLength} bytes, expected ${FORK_STATIC_ROOT_CATALOG_HEADER_SIZE}`,
    ];
  }
  const failures: string[] = [];
  if (
    FORK_STATIC_ROOT_CATALOG_MAGIC.some(
      (byte, index) => descriptor[index] !== byte,
    )
  ) {
    failures.push(`${FORK_STATIC_ROOT_CATALOG_SECTION} has invalid magic`);
  }
  const view = new DataView(
    descriptor.buffer,
    descriptor.byteOffset,
    descriptor.byteLength,
  );
  if (view.getUint16(4, true) !== FORK_STATIC_ROOT_CATALOG_VERSION) {
    failures.push(
      `${FORK_STATIC_ROOT_CATALOG_SECTION} version ${view.getUint16(4, true)} is unsupported`,
    );
  }
  if (view.getUint16(6, true) !== FORK_STATIC_ROOT_CATALOG_HEADER_SIZE) {
    failures.push(
      `${FORK_STATIC_ROOT_CATALOG_SECTION} declares an invalid header size`,
    );
  }
  const count = view.getUint32(8, true);
  const exports = facts.tableExports.get(FORK_STATIC_ROOT_CATALOG_EXPORT);
  if (!exports || exports.length !== 1) {
    failures.push(
      `missing exactly one table export ${FORK_STATIC_ROOT_CATALOG_EXPORT}`,
    );
    return failures;
  }
  const importedTableCount = [...facts.tableImports.values()]
    .reduce((total, entries) => total + entries.length, 0);
  const tableIndex = exports[0]!;
  const table = facts.tables[tableIndex];
  if (tableIndex < importedTableCount || !table) {
    failures.push(
      `${FORK_STATIC_ROOT_CATALOG_EXPORT} must export a module-local table`,
    );
    return failures;
  }
  if (
    table.elementType !== 0x6e
    || table.table64
    || table.minimum !== count
    || table.maximum !== count
  ) {
    failures.push(
      `${FORK_STATIC_ROOT_CATALOG_EXPORT} must be a fixed table32 anyref catalog of length ${count}`,
    );
  }
  return failures;
}

function describeForkArtifactContractFailures(
  facts: WasmForkArtifactFacts,
): string[] {
  const failures: string[] = [];
  if (facts.nativeStartCount !== 0) {
    // WHY: staged dlopen may instantiate this module while a loader import is
    // active. The transform must defer the source start function to the
    // explicit bootstrap so guest Wasm cannot reenter that import.
    failures.push(
      `ABI 43 fork artifact retains ${facts.nativeStartCount} native Wasm start ` +
        `section${facts.nativeStartCount === 1 ? "" : "s"}; rebuild and ` +
        "reinstrument it so initialization is owned by " +
        "wpk_fork_module_bootstrap",
    );
  }
  if (facts.functionImports.has("env.__wasm_dlopen")) {
    // WHY: this host import can synchronously enter side-module Wasm before
    // returning. ABI 43 instrumentation lowers every valid occurrence to the
    // staged prepare/next/commit protocol, so retaining it proves that the
    // activation-state capability was copied or emitted by an incomplete
    // transform.
    failures.push(
      "ABI 43 fork artifact retains reentrant env.__wasm_dlopen; " +
        "rebuild and reinstrument it with the staged loader lowering",
    );
  }
  failures.push(...validateForkCapabilities(facts.forkCapabilities));
  failures.push(
    ...validateForkExceptionCodecDescriptor(facts.exceptionCodecDescriptors),
    ...validateForkImportedGlobalsDescriptor(facts),
    ...validateForkImportedTablesDescriptor(facts),
    ...validateForkActivationImport(facts),
    ...validateForkTableImports(facts),
    ...validateForkStaticRootCatalog(facts),
  );
  for (const requirement of WPK_FORK_REQUIRED_EXPORTS) {
    const signatures = facts.functionExports.get(requirement.name);
    if (!signatures) continue;
    if (signatures.length !== 1) {
      failures.push(`duplicate ABI 43 wasm-fork-instrument export ${requirement.name}`);
    }
  }
  const missingExports = WPK_FORK_REQUIRED_EXPORTS
    .filter(({ name }) => !facts.functionExports.has(name))
    .map(({ name }) => name);
  if (missingExports.length > 0) {
    failures.push(
      `incomplete wasm-fork-instrument exports; missing ${missingExports.join(", ")}`,
    );
  }

  if (facts.importsKernelFork) {
    const identity =
      `${WPK_FORK_PROCESS_IMPORT.module}.${WPK_FORK_PROCESS_IMPORT.name}`;
    const signatures = facts.functionImports.get(identity);
    if (signatures?.length !== 1) {
      failures.push(`duplicate ABI 43 process-fork import ${identity}`);
    } else if (
      !signatureMatches(
        signatures[0],
        WPK_FORK_PROCESS_IMPORT.params,
        WPK_FORK_PROCESS_IMPORT.results,
        4,
      )
    ) {
      failures.push(
        `ABI 43 process-fork import ${identity} has the wrong signature; expected ${
          signatureText(
            WPK_FORK_PROCESS_IMPORT.params,
            WPK_FORK_PROCESS_IMPORT.results,
            4,
          )
        }`,
      );
    }
  }

  const checkpointIdentity =
    `${WPK_CHECKPOINT_PROCESS_IMPORT.module}.${WPK_CHECKPOINT_PROCESS_IMPORT.name}`;
  const checkpointSignatures = facts.functionImports.get(checkpointIdentity);
  if (checkpointSignatures) {
    if (checkpointSignatures.length !== 1) {
      failures.push(
        `duplicate ABI 44 process-checkpoint import ${checkpointIdentity}`,
      );
    } else if (
      !signatureMatches(
        checkpointSignatures[0],
        WPK_CHECKPOINT_PROCESS_IMPORT.params,
        WPK_CHECKPOINT_PROCESS_IMPORT.results,
        4,
      )
    ) {
      failures.push(
        `ABI 44 process-checkpoint import ${checkpointIdentity} has the wrong signature; expected ${
          signatureText(
            WPK_CHECKPOINT_PROCESS_IMPORT.params,
            WPK_CHECKPOINT_PROCESS_IMPORT.results,
            4,
          )
        }`,
      );
    }
  }

  let pointerWidth: number | null = null;
  if (facts.linkedFrameDescriptors.length === 0) {
    failures.push(`missing required ${WPK_FORK_LINKED_FRAME_FORMAT_SECTION} descriptor`);
  } else if (facts.linkedFrameDescriptors.length !== 1) {
    failures.push(
      `has ${facts.linkedFrameDescriptors.length} ${WPK_FORK_LINKED_FRAME_FORMAT_SECTION} descriptors, expected exactly one`,
    );
  } else {
    try {
      pointerWidth = validateLinkedFrameDescriptor(facts.linkedFrameDescriptors[0]);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  failures.push(
    ...validateForkModuleStateDescriptor(
      facts.moduleStateDescriptors,
      pointerWidth,
    ),
  );

  const presentFrameImports = WPK_FORK_REQUIRED_IMPORTS.filter(({ module, name }) =>
    facts.functionImports.has(`${module}.${name}`)
  );
  const unwindTagIdentity =
    `${FORK_UNWIND_TAG_IMPORT_MODULE}.${FORK_UNWIND_TAG_IMPORT_NAME}`;
  const requiresFrameImports = facts.importsKernelFork || presentFrameImports.length > 0;
  const requiresUnwindTransport =
    requiresFrameImports
    || facts.tagImports.has(unwindTagIdentity)
    || facts.unwindTransportDescriptors.length > 0;
  if (requiresUnwindTransport) {
    failures.push(...validateForkUnwindTransport(facts));
  }
  if (requiresFrameImports) {
    const missingImports = WPK_FORK_REQUIRED_IMPORTS
      .filter(({ module, name }) => !facts.functionImports.has(`${module}.${name}`))
      .map(({ module, name }) => `${module}.${name}`);
    if (missingImports.length > 0) {
      failures.push(
        `incomplete ABI 43 fork-runtime imports; missing ${missingImports.join(", ")}`,
      );
    }
    for (const requirement of WPK_FORK_REQUIRED_IMPORTS) {
      const identity = `${requirement.module}.${requirement.name}`;
      const signatures = facts.functionImports.get(identity);
      if (signatures && signatures.length !== 1) {
        failures.push(`duplicate ABI 43 fork-runtime import ${identity}`);
      }
    }
  }

  if (pointerWidth !== null) {
    if (facts.memoryPointerWidths.length !== 1) {
      failures.push(
        `ABI 43 fork instrumentation requires exactly one module memory, found ${facts.memoryPointerWidths.length}`,
      );
    } else if (facts.memoryPointerWidths[0] !== pointerWidth) {
      const article = pointerWidth === 8 ? "an" : "a";
      failures.push(
        `ABI 43 linked-frame descriptor declares ${article} ${pointerWidth}-byte pointer but the module memory uses ${facts.memoryPointerWidths[0]}-byte addresses`,
      );
    }
    for (const requirement of WPK_FORK_REQUIRED_EXPORTS) {
      const signatures = facts.functionExports.get(requirement.name);
      if (
        signatures?.length === 1 &&
        !signatureMatches(
          signatures[0],
          requirement.params,
          requirement.results,
          pointerWidth,
        )
      ) {
        failures.push(
          `ABI 43 wasm-fork-instrument export ${requirement.name} has the wrong signature; expected ${
            signatureText(requirement.params, requirement.results, pointerWidth)
          }`,
        );
      }
    }
    if (requiresFrameImports) {
      for (const requirement of WPK_FORK_REQUIRED_IMPORTS) {
        const identity = `${requirement.module}.${requirement.name}`;
        const signatures = facts.functionImports.get(identity);
        if (
          signatures?.length === 1 &&
          !signatureMatches(
            signatures[0],
            requirement.params,
            requirement.results,
            pointerWidth,
          )
        ) {
          failures.push(
            `ABI 43 fork-runtime import ${identity} has the wrong signature; expected ${
              signatureText(requirement.params, requirement.results, pointerWidth)
            }`,
          );
        }
      }
    }
  }

  return failures;
}

/**
 * Validate the complete ABI-epoch fork contract without compiling or running
 * the artifact. This is shared by program admission and the dynamic linker so
 * a side module cannot defer a malformed reconstruction recipe until replay.
 */
export function describeWasmForkArtifactContractFailures(
  programBytes: ArrayBuffer,
): string[] {
  try {
    return describeForkArtifactContractFailures(
      readWasmForkArtifactFacts(programBytes),
    );
  } catch (error) {
    return [
      `cannot validate ABI 43 fork-artifact contract: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
  }
}

/**
 * Return exact function-import identities, ordinals, and binary signatures.
 *
 * WebAssembly.Module.imports() omits function types. Fork-safe host-import
 * routing needs the artifact-declared signature so an owner descriptor cannot
 * accidentally reinterpret the same scalar words under a different type.
 */
export function readWasmFunctionImports(
  programBytes: ArrayBuffer,
): readonly WasmFunctionImportType[] {
  return Object.freeze(
    readWasmForkArtifactFacts(programBytes).functionImportEntries.map(
      (entry) =>
        Object.freeze({
          ...entry,
          signature: Object.freeze({
            params: Object.freeze([...entry.signature.params]),
            results: Object.freeze([...entry.signature.results]),
            paramTypes: Object.freeze(
              entry.signature.paramTypes.map((type) =>
                Object.freeze({ ...type })
              ),
            ),
            resultTypes: Object.freeze(
              entry.signature.resultTypes.map((type) =>
                Object.freeze({ ...type })
              ),
            ),
          }),
        }),
    ),
  );
}

/** Return the exact parameter/result arity for one core function index. */
export function readWasmFunctionArity(
  programBytes: ArrayBuffer,
  functionIndex: number,
): Readonly<{ parameters: number; results: number }> | null {
  if (!Number.isSafeInteger(functionIndex) || functionIndex < 0) return null;
  const facts = readWasmForkArtifactFacts(programBytes);
  const typeIndex = facts.functionTypeIndices[functionIndex];
  if (typeIndex === undefined) return null;
  const signature = facts.functionTypes[typeIndex];
  if (signature === undefined) return null;
  return Object.freeze({
    parameters: signature.params.length,
    results: signature.results.length,
  });
}

export type DecodedWasmExternalKind =
  | "function"
  | "table"
  | "memory"
  | "global"
  | "tag";

export interface DecodedWasmImportDescriptor {
  readonly module: string;
  readonly name: string;
  readonly kind: DecodedWasmExternalKind;
}

export interface DecodedWasmExportDescriptor {
  readonly name: string;
  readonly kind: DecodedWasmExternalKind;
}

function decodedExternalKind(
  kind: number,
  context: string,
): DecodedWasmExternalKind {
  switch (kind) {
    case 0:
      return "function";
    case 1:
      return "table";
    case 2:
      return "memory";
    case 3:
      return "global";
    case 4:
      return "tag";
    default:
      throw new Error(`${context} has unsupported external kind ${kind}`);
  }
}

/**
 * Decode every import name and kind in declaration order.
 *
 * This is intentionally a binary-section parser rather than
 * `WebAssembly.Module.imports()`: release/resolver guards can inspect binaries
 * built with newer Wasm features than the current JS engine can reflect, and
 * WebKit cannot currently produce descriptors for some valid exception-
 * reference imports. The same parser already validates the richer ABI 43
 * function/global/table contract above.
 */
export function readWasmImportDescriptors(
  programBytes: ArrayBuffer,
): readonly DecodedWasmImportDescriptor[] {
  const src = new Uint8Array(programBytes);
  if (!hasWasmMagic(src)) return [];

  const imports: DecodedWasmImportDescriptor[] = [];
  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      let pos = contentOffset;
      const [importCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [moduleName, afterModule] = readName(src, pos);
        const [fieldName, afterField] = readName(src, afterModule);

        pos = afterField;
        const kind = src[pos++];
        imports.push({
          module: moduleName,
          name: fieldName,
          kind: decodedExternalKind(kind, `import ${moduleName}.${fieldName}`),
        });
        if (kind === 0) {
          const [, n] = readULEB128(src, pos); pos += n;
        } else if (kind === 1) {
          pos = readWasmValueType(src, pos, "table import type").next;
          pos = readLimits(src, pos).next;
        } else if (kind === 2) {
          pos = readLimits(src, pos).next;
        } else if (kind === 3) {
          pos = readWasmValueType(src, pos, "global import type").next;
          pos++;
        } else if (kind === 4) {
          pos++; // tag attribute
          const [, typeBytes] = readULEB128(src, pos); pos += typeBytes;
        }
      }
      break;
    }

    offset = contentOffset + sectionSize;
  }
  return imports;
}

/** Return import names in `module.field` form. */
export function readWasmImportNames(programBytes: ArrayBuffer): string[] {
  return readWasmImportDescriptors(programBytes).map(
    ({ module, name }) => `${module}.${name}`,
  );
}

/** Decode every export name and kind in declaration order. */
export function readWasmExportDescriptors(
  programBytes: ArrayBuffer,
): readonly DecodedWasmExportDescriptor[] {
  const src = new Uint8Array(programBytes);
  if (!hasWasmMagic(src)) return [];

  const exports: DecodedWasmExportDescriptor[] = [];
  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 7) {
      let pos = contentOffset;
      const [exportCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [name, afterName] = readName(src, pos);
        pos = afterName;
        const kind = src[pos++];
        exports.push({
          name,
          kind: decodedExternalKind(kind, `export ${name}`),
        });
        const [, indexBytes] = readULEB128(src, pos);
        pos += indexBytes;
      }
      break;
    }

    offset = contentOffset + sectionSize;
  }
  return exports;
}

/** Return all export names from a wasm module. */
export function readWasmExportNames(programBytes: ArrayBuffer): string[] {
  return readWasmExportDescriptors(programBytes).map(({ name }) => name);
}

/** Return all custom-section names from a wasm module. */
export function readWasmCustomSectionNames(programBytes: ArrayBuffer): string[] {
  const src = new Uint8Array(programBytes);
  if (!hasWasmMagic(src)) return [];

  const names: string[] = [];
  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 0) {
      const [name] = readName(src, contentOffset);
      names.push(name);
    }

    offset = contentOffset + sectionSize;
  }
  return names;
}

/**
 * Custom-section name carrying the 32-byte ABI-contract digest
 * (`hash(abi/snapshot.json + ABI_VERSION)`) a wasm artifact was built against.
 * Stamped by the local-build engine (`tools/xtask/src/build_stamp.rs`,
 * `ABI_CONTRACT_SECTION`) onto every program — kernel, userspace, and every
 * guest. The host reads the kernel's own stamp at init and compares each
 * guest's stamp against it at exec, so a structural ABI change can't let a
 * stale guest run against a mismatched kernel even when the ABI version
 * numbers coincide.
 */
export const ABI_CONTRACT_SECTION = "kandelo.abi.contract";

/**
 * Return the payload bytes (after the section name) of the first custom
 * section named `name`, or `null` if the module carries no such section.
 * Mirrors {@link readWasmCustomSectionNames}' walker but exposes the payload.
 */
export function readWasmCustomSectionPayload(
  programBytes: ArrayBuffer,
  name: string,
): Uint8Array | null {
  const src = new Uint8Array(programBytes);
  if (!hasWasmMagic(src)) return null;

  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;
    const sectionEnd = contentOffset + sectionSize;

    if (sectionId === 0) {
      const [sectionName, afterName] = readName(src, contentOffset);
      if (sectionName === name) {
        return src.subarray(afterName, sectionEnd);
      }
    }

    offset = sectionEnd;
  }
  return null;
}

/** Constant-shape 32-byte compare of two ABI-contract digests. */
function abiContractDigestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function wasmContainsLegacyAsyncify(programBytes: ArrayBuffer): boolean {
  return containsAscii(new Uint8Array(programBytes), "asyncify_");
}

export function wasmImportsKernelFork(programBytes: ArrayBuffer): boolean {
  return readWasmImportNames(programBytes).includes("kernel.kernel_fork");
}

export function wasmHasCompleteForkInstrumentation(programBytes: ArrayBuffer): boolean {
  try {
    const facts = readWasmForkArtifactFacts(programBytes);
    const hasForkSurface = WPK_FORK_REQUIRED_EXPORTS.some(({ name }) =>
      facts.functionExports.has(name)
    ) || facts.linkedFrameDescriptors.length > 0
      || facts.exceptionCodecDescriptors.length > 0
      || facts.importedGlobalsDescriptors.length > 0
      || facts.importedTablesDescriptors.length > 0;
    return hasForkSurface && describeForkArtifactContractFailures(facts).length === 0;
  } catch {
    return false;
  }
}

export function wasmIsRelocatableObject(programBytes: ArrayBuffer): boolean {
  const customSections = readWasmCustomSectionNames(programBytes);
  return customSections.includes("linking") ||
    customSections.some((name) => name.startsWith("reloc."));
}

/**
 * Warn once per worker process when a guest lacks the ABI-contract stamp,
 * not once per program load (mirrors `abiMissingWarned` in worker-main.ts).
 */
let abiContractMissingWarned = false;

export function describeWasmArtifactPolicyFailures(
  programBytes: ArrayBuffer,
  options: {
    expectedAbi?: number | null;
    expectedAbiContractDigest?: Uint8Array | null;
    requiredExports?: readonly string[];
    forbiddenExports?: readonly string[];
    requireForkInstrumentation?: boolean;
    forbidForkInstrumentation?: boolean;
  } = {},
): string[] {
  const failures: string[] = [];
  let declaredAbi: number | null = null;
  if (wasmContainsLegacyAsyncify(programBytes)) {
    failures.push("contains asyncify_");
  }

  if (options.expectedAbi !== undefined && options.expectedAbi !== null) {
    declaredAbi = extractAbiVersion(programBytes);
    if (declaredAbi !== null && declaredAbi !== options.expectedAbi) {
      failures.push(`ABI ${declaredAbi}, expected ${options.expectedAbi}`);
    }
  }

  // ABI-contract digest gate (Stage 3): the ABI version NUMBER can coincide
  // across a structural ABI change that regenerated abi/snapshot.json. The
  // 32-byte contract digest binds hash(abi/snapshot.json + ABI_VERSION), so a
  // guest built against a different snapshot is caught even when the numbers
  // match. Warn-then-enforce during rollout: an UNSTAMPED (legacy) guest warns
  // once and passes; a STAMPED-but-mismatched guest fails hard.
  if (
    options.expectedAbiContractDigest !== undefined &&
    options.expectedAbiContractDigest !== null
  ) {
    const guestDigest = readWasmCustomSectionPayload(programBytes, ABI_CONTRACT_SECTION);
    if (guestDigest === null) {
      if (!abiContractMissingWarned) {
        abiContractMissingWarned = true;
        console.warn(
          "[worker] user program lacks a kandelo.abi.contract stamp — " +
            "legacy binary predates the ABI-contract-digest rollout. Rebuild " +
            "it through the local-build engine to pick up the check. " +
            "See docs/abi-versioning.md.",
        );
      }
    } else if (!abiContractDigestsEqual(guestDigest, options.expectedAbiContractDigest)) {
      failures.push(
        "ABI contract digest mismatch — guest built against a different ABI " +
          "snapshot than the running kernel; rebuild the guest",
      );
    }
  }

  const exports = new Set(readWasmExportNames(programBytes));
  if (options.requiredExports) {
    const missing = options.requiredExports.filter((name) => !exports.has(name));
    if (missing.length > 0) {
      failures.push(`missing required exports: ${missing.join(", ")}`);
    }
  }
  if (options.forbiddenExports) {
    const forbidden = options.forbiddenExports.filter((name) => exports.has(name));
    if (forbidden.length > 0) {
      failures.push(`forbidden exports present: ${forbidden.join(", ")}`);
    }
  }

  const presentWpkExports = WPK_FORK_EXPORTS.filter((name) => exports.has(name));
  const importNames = readWasmImportNames(programBytes);
  const customSections = readWasmCustomSectionNames(programBytes);
  const presentWpkImports = WPK_FORK_REQUIRED_IMPORTS.filter(({ module, name }) =>
    importNames.includes(`${module}.${name}`)
  );
  const descriptorCount = customSections.filter((name) =>
    name === WPK_FORK_LINKED_FRAME_FORMAT_SECTION
  ).length;
  const capabilityCount = customSections.filter((name) =>
    name === WPK_FORK_CAPABILITIES_SECTION
  ).length;
  const moduleStateDescriptorCount = customSections.filter((name) =>
    name === WPK_FORK_MODULE_STATE_FORMAT_SECTION
  ).length;
  const exceptionCodecDescriptorCount = customSections.filter((name) =>
    name === WPK_FORK_EXCEPTION_CODEC_SECTION
  ).length;
  const importedGlobalsDescriptorCount = customSections.filter((name) =>
    name === WPK_FORK_IMPORTED_GLOBALS_SECTION
  ).length;
  const importedTablesDescriptorCount = customSections.filter((name) =>
    name === WPK_FORK_IMPORTED_TABLES_SECTION
  ).length;
  const unwindTransportCount = customSections.filter((name) =>
    name === FORK_UNWIND_TRANSPORT_SECTION
  ).length;
  const hasUnwindTagImport = importNames.includes(
    `${FORK_UNWIND_TAG_IMPORT_MODULE}.${FORK_UNWIND_TAG_IMPORT_NAME}`,
  );
  const hasForkArtifactSurface =
    presentWpkExports.length > 0 || presentWpkImports.length > 0 ||
    descriptorCount > 0 || capabilityCount > 0 ||
    moduleStateDescriptorCount > 0 || exceptionCodecDescriptorCount > 0 ||
    importedGlobalsDescriptorCount > 0 || importedTablesDescriptorCount > 0 ||
    unwindTransportCount > 0 ||
    hasUnwindTagImport;
  if (
    options.expectedAbi !== undefined &&
    options.expectedAbi !== null &&
    hasForkArtifactSurface &&
    declaredAbi === null
  ) {
    // WHY: the safety bit names an ABI-epoch contract. Without the program's
    // ABI marker, copied capability metadata could make an ABI 42 transform
    // look safe to an ABI 43 host.
    failures.push(
      `ABI ${options.expectedAbi} fork artifact is missing __abi_version; ` +
        "the activation-state capability epoch cannot be verified",
    );
  }
  if (options.forbidForkInstrumentation && hasForkArtifactSurface) {
    failures.push(
      `contains ABI ${options.expectedAbi} wasm-fork-instrument metadata, ` +
        "imports, or exports",
    );
  }

  const requireForkInstrumentation =
    options.requireForkInstrumentation ?? !wasmIsRelocatableObject(programBytes);
  if (
    requireForkInstrumentation &&
    (hasForkArtifactSurface || importNames.includes("kernel.kernel_fork"))
  ) {
    try {
      failures.push(
        ...describeForkArtifactContractFailures(readWasmForkArtifactFacts(programBytes)),
      );
    } catch (error) {
      failures.push(
        `cannot validate ABI 43 fork-artifact contract: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return failures;
}

/**
 * Read a global's init expression. Returns the address value as bigint
 * (to handle both wasm32 i32 and wasm64 i64 uniformly), or null if the
 * init expression isn't a simple `i32.const`/`i64.const`.
 */
function readGlobalInitAddr(src: Uint8Array, pos: number): bigint | null {
  // valtype + mut + init expr (terminated by 0x0B)
  pos = readWasmValueType(src, pos, "global type").next;
  pos++; // mut
  const opcode = src[pos++];
  if (opcode === 0x41) {
    // i32.const
    const [val] = readSLEB128_i32(src, pos);
    return BigInt.asUintN(32, BigInt(val));
  } else if (opcode === 0x42) {
    // i64.const
    const [val] = readSLEB128_i64(src, pos);
    return BigInt.asUintN(64, val);
  }
  // Other init expressions (global.get, ref.func, etc.) are not used
  // for __heap_base by current LLD output.
  return null;
}

/**
 * Skip past a global's payload (valtype + mut + init expression). The init
 * expression ends at the first 0x0B (end) opcode.
 */
function skipGlobalEntry(src: Uint8Array, pos: number): number {
  pos = readWasmValueType(src, pos, "global type").next;
  pos++; // mutability
  for (;;) {
    if (pos >= src.length) throw new Error("global init expression is truncated");
    const opcode = src[pos++]!;
    switch (opcode) {
      case 0x0b: // end
        return pos;
      case 0x41: // i32.const
        pos = skipSignedLeb128(src, pos, 5, "i32 global initializer");
        break;
      case 0x42: // i64.const
        pos = skipSignedLeb128(src, pos, 10, "i64 global initializer");
        break;
      case 0x43: // f32.const
        pos += 4;
        break;
      case 0x44: // f64.const
        pos += 8;
        break;
      case 0x23: // global.get
      case 0xd2: { // ref.func
        const [, bytes] = readULEB128(src, pos);
        pos += bytes;
        break;
      }
      case 0xd0: // ref.null heaptype
        pos = skipSignedLeb128(src, pos, 5, "ref.null global initializer");
        break;
      default:
        throw new Error(
          `global init expression has unsupported opcode 0x${opcode.toString(16)}`,
        );
    }
    if (pos > src.length) throw new Error("global init expression is truncated");
  }
}

/**
 * Extract the `__heap_base` export's value from a wasm binary by parsing
 * the Import + Export + Global sections. Returns the address (as bigint
 * to handle wasm64), or null if `__heap_base` is not exported or its
 * init expression isn't a plain const.
 *
 * Used by the host to call `kernel_set_brk_base` before a new program's
 * `_start` runs, so `brk(0)` returns a value above the program's data
 * and stack region (avoids heap/shadow-stack overlap for programs with
 * large data sections like mariadbd).
 */
export function extractHeapBase(programBytes: ArrayBuffer): bigint | null {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return null;

  let globalImports = 0;
  let funcImports = 0;
  let heapBaseGlobalIndex: number | null = null;
  let globalSectionContent: { offset: number; size: number } | null = null;

  let offset = 8; // skip magic + version
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      // Import section — count global imports
      const counts = { funcImports, globalImports };
      let pos = contentOffset;
      const [importCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        pos = skipImportEntry(src, pos, counts);
      }
      funcImports = counts.funcImports;
      globalImports = counts.globalImports;
    } else if (sectionId === 6) {
      // Global section — defer until we know the global index
      globalSectionContent = { offset: contentOffset, size: sectionSize };
    } else if (sectionId === 7) {
      // Export section — find __heap_base
      let pos = contentOffset;
      const [exportCount, countBytes] = readULEB128(src, pos); pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readULEB128(src, pos); pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen)); pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readULEB128(src, pos); pos += idxBytes;
        if (kind === 3 && name === "__heap_base") {
          heapBaseGlobalIndex = idx;
          break;
        }
      }
      if (heapBaseGlobalIndex === null) return null;
      if (globalSectionContent === null) {
        // Sections appear in canonical order, so Global (id=6) comes
        // before Export (id=7). Reaching here means the binary is
        // malformed or the global is imported (not defined locally).
        return null;
      }
      break;
    }

    offset = contentOffset + sectionSize;
  }

  if (heapBaseGlobalIndex === null || globalSectionContent === null) return null;

  // The export's global index counts both imports and defined globals.
  // Defined globals start at index `globalImports`.
  const definedIndex = heapBaseGlobalIndex - globalImports;
  if (definedIndex < 0) return null; // imported global, can't read its init here

  let pos = globalSectionContent.offset;
  const [globalCount, countBytes] = readULEB128(src, pos); pos += countBytes;
  if (definedIndex >= globalCount) return null;

  for (let i = 0; i < definedIndex; i++) {
    pos = skipGlobalEntry(src, pos);
  }
  return readGlobalInitAddr(src, pos);
}

/**
 * Extract the constant value returned by a program's `__abi_version`
 * export, if present. The glue (`libc/glue/channel_syscall.c`) defines this
 * function as a single `i32.const N; end` (often with the standard
 * export-wrapper `call __wasm_call_ctors` prefix). Fork instrumentation can
 * inject its own constants before that return path, so parse the body and only
 * accept an `i32.const` that is returned directly.
 *
 * Used by tests to skip cleanly when cached binaries were built against
 * a different `ABI_VERSION` than the running kernel.
 */
function extractI32ConstFunctionExport(
  programBytes: ArrayBuffer,
  exportName: string,
): number | null {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return null;

  let funcImports = 0;
  let abiFuncIndex: number | null = null;
  let codeSectionContent: { offset: number; size: number } | null = null;

  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      const counts = { funcImports, globalImports: 0 };
      let pos = contentOffset;
      const [importCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        pos = skipImportEntry(src, pos, counts);
      }
      funcImports = counts.funcImports;
    } else if (sectionId === 7) {
      let pos = contentOffset;
      const [exportCount, countBytes] = readULEB128(src, pos); pos += countBytes;
      for (let i = 0; i < exportCount; i++) {
        const [nameLen, nameLenBytes] = readULEB128(src, pos); pos += nameLenBytes;
        const name = new TextDecoder().decode(src.subarray(pos, pos + nameLen)); pos += nameLen;
        const kind = src[pos++];
        const [idx, idxBytes] = readULEB128(src, pos); pos += idxBytes;
        if (kind === 0 && name === exportName) {
          abiFuncIndex = idx;
          break;
        }
      }
    } else if (sectionId === 10) {
      codeSectionContent = { offset: contentOffset, size: sectionSize };
    }

    offset = contentOffset + sectionSize;
  }

  if (abiFuncIndex === null || codeSectionContent === null) return null;

  let funcCountPos = codeSectionContent.offset;
  const [funcCount, funcCountBytes] = readULEB128(src, funcCountPos);
  funcCountPos += funcCountBytes;

  function bodyRangeForFunc(funcIndex: number): { start: number; end: number } | null {
    const definedIndex = funcIndex - funcImports;
    if (definedIndex < 0 || definedIndex >= funcCount) return null;

    let pos = funcCountPos;
    for (let i = 0; i < definedIndex; i++) {
      const [bodySize, bodySizeBytes] = readULEB128(src, pos);
      pos += bodySizeBytes + bodySize;
    }
    const [bodySize, bodySizeBytes] = readULEB128(src, pos);
    pos += bodySizeBytes;
    return { start: pos, end: pos + bodySize };
  }

  function skipLocals(pos: number, bodyEnd: number): number | null {
    if (pos >= bodyEnd) return null;
    const [localGroups, localGroupsBytes] = readULEB128(src, pos);
    pos += localGroupsBytes;
    for (let i = 0; i < localGroups; i++) {
      const [, n] = readULEB128(src, pos); pos += n; // count
      try {
        pos = readWasmValueType(src, pos, `function local group ${i}`).next;
      } catch {
        return null;
      }
      if (pos > bodyEnd) return null;
    }
    return pos;
  }

  function extractFromFunc(funcIndex: number, depth = 0): number | null {
    if (depth > 4) return null;
    const range = bodyRangeForFunc(funcIndex);
    if (!range) return null;

    const localsEnd = skipLocals(range.start, range.end);
    if (localsEnd === null) return null;
    let pos = localsEnd;
    const bodyEnd = range.end;

    // Walk instructions and find the constant directly returned by this
    // trivial marker export. wasm-fork-instrument may wrap exported command
    // functions; when the wrapper does `call real_marker; return`, follow it.
    while (pos < bodyEnd) {
      const op = src[pos++];
      if (op === 0x0b) {
        if (pos === bodyEnd) return null;
        continue;
      }
      if (op === 0x41) {
        const [val] = readSLEB128_i32(src, pos);
        const [, n] = readSLEB128_i32(src, pos);
        const next = pos + n;
        if (src[next] === 0x0f || (src[next] === 0x0b && next + 1 === bodyEnd)) {
          return val;
        }
        pos = next;
      } else if (op === 0x10) {
        const [callee, n] = readULEB128(src, pos);
        const next = pos + n;
        if (src[next] === 0x0f || (src[next] === 0x0b && next + 1 === bodyEnd)) {
          const val = extractFromFunc(callee, depth + 1);
          if (val !== null) return val;
        }
        pos = next;
      } else if (op === 0x0c || op === 0x0d || op === 0x12 || op === 0xd2) {
        const [, n] = readULEB128(src, pos);
        pos += n;
      } else if (op === 0x02 || op === 0x03 || op === 0x04) {
        pos = skipWasmBlockType(src, pos);
      } else if (op === 0x0e) {
        const [targetCount, targetCountBytes] = readULEB128(src, pos);
        pos += targetCountBytes;
        for (let i = 0; i <= targetCount; i++) {
          const [, n] = readULEB128(src, pos);
          pos += n;
        }
      } else if (op === 0x11) {
        const [, typeBytes] = readULEB128(src, pos);
        pos += typeBytes;
        const [, tableBytes] = readULEB128(src, pos);
        pos += tableBytes;
      } else if (op === 0x1c) {
        const [typeCount, typeCountBytes] = readULEB128(src, pos);
        pos += typeCountBytes;
        for (let i = 0; i < typeCount; i++) {
          const [, n] = readULEB128(src, pos);
          pos += n;
        }
      } else if ((op >= 0x20 && op <= 0x26) || op === 0xd0) {
        const [, n] = readULEB128(src, pos);
        pos += n;
      } else if (op >= 0x28 && op <= 0x3e) {
        pos = skipVectorMemarg(src, pos);
      } else if (op === 0x3f || op === 0x40) {
        pos++;
      } else if (op === 0x42) {
        const [, n] = readSLEB128_i64(src, pos);
        pos += n;
      } else if (op === 0x43) {
        pos += 4;
      } else if (op === 0x44) {
        pos += 8;
      } else if (op === 0xfc || op === 0xfd || op === 0xfe) {
        const next = skipPrefixedInstructionImmediate(op, src, pos);
        if (next === null) return null;
        pos = next;
      } else {
        // Most scalar numeric/control/parametric instructions have no immediates.
      }
    }
    return null;
  }

  return extractFromFunc(abiFuncIndex);
}

export function extractAbiVersion(programBytes: ArrayBuffer): number | null {
  return extractI32ConstFunctionExport(programBytes, "__abi_version");
}

/**
 * Extract a process-wasm pthread slot declaration.
 *
 * The SDK emits this as a constant-return export. A missing export means the
 * binary predates the declaration and should use the host default.
 */
export function extractThreadSlotDeclaration(programBytes: ArrayBuffer): number | null {
  return extractI32ConstFunctionExport(
    programBytes,
    PROCESS_MEMORY_THREAD_SLOT_DECL_EXPORT,
  );
}

/**
 * Detect whether a wasm binary is wasm32 or wasm64 by parsing the import
 * section for a memory import with the memory64 flag (bit 2 of flags byte).
 * Returns 4 for wasm32, 8 for wasm64.
 */
export function detectPtrWidth(programBytes: ArrayBuffer): 4 | 8 {
  const src = new Uint8Array(programBytes);
  if (src.length < 8) return 4;

  // Skip magic + version (8 bytes)
  let offset = 8;
  while (offset < src.length) {
    const sectionId = src[offset];
    const [sectionSize, sizeBytes] = readULEB128(src, offset + 1);
    const contentOffset = offset + 1 + sizeBytes;

    if (sectionId === 2) {
      // Import section — look for memory imports
      let pos = contentOffset;
      const [importCount, countBytes] = readULEB128(src, pos);
      pos += countBytes;
      for (let i = 0; i < importCount; i++) {
        const [modLen, modLenBytes] = readULEB128(src, pos); pos += modLenBytes + modLen;
        const [fieldLen, fieldLenBytes] = readULEB128(src, pos); pos += fieldLenBytes + fieldLen;
        const kind = src[pos++];
        if (kind === 2) {
          const limits = readLimits(src, pos);
          if ((limits.flags & 0x04) !== 0) return 8;
          return 4;
        }
        // Skip non-memory imports
        if (kind === 0) { const [, n] = readULEB128(src, pos); pos += n; }
        else if (kind === 1) {
          pos = readWasmValueType(src, pos, "table import type").next;
          pos = readLimits(src, pos).next;
        }
        else if (kind === 3) {
          pos = readWasmValueType(src, pos, "global import type").next;
          pos++;
        } else if (kind === 4) {
          pos++; // tag attribute
          const [, typeBytes] = readULEB128(src, pos);
          pos += typeBytes;
        }
      }
      break;
    }

    offset = contentOffset + sectionSize;
  }

  return 4; // default wasm32
}
