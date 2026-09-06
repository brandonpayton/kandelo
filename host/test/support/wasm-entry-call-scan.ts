/**
 * Read the ordered call sequence of one exported function straight from a
 * module's code section.
 *
 * `wasm-objdump` cannot answer this question about a Kandelo artifact. Every
 * program that `scripts/build-programs.sh` publishes carries reference types
 * and a tag import, which the pinned WABT rejects while still printing a
 * disassembly: it drops the import section, so its `func[N]` labels are shifted
 * and its call targets stay numeric. A shifted label read as a name is a wrong
 * answer that looks like a right one.
 *
 * This walker refuses to guess. It reports a call sequence only when the walk
 * lands exactly on the end of the body; any other outcome throws.
 */

export type WasmEntryCall =
  | { readonly kind: "call"; readonly target: string }
  | { readonly kind: "call_indirect" };

const SECTION_IMPORT = 2;
const SECTION_EXPORT = 7;
const SECTION_CODE = 10;

const EXTERNAL_KIND_FUNCTION = 0;
const EXTERNAL_KIND_TABLE = 1;
const EXTERNAL_KIND_MEMORY = 2;
const EXTERNAL_KIND_GLOBAL = 3;
const EXTERNAL_KIND_TAG = 4;

const OP_BLOCK = 0x02;
const OP_LOOP = 0x03;
const OP_IF = 0x04;
const OP_THROW = 0x08;
const OP_TRY_TABLE = 0x1f;
const OP_CALL = 0x10;
const OP_CALL_INDIRECT = 0x11;
const OP_BR_TABLE = 0x0e;
const OP_SELECT_T = 0x1c;

interface Reader {
  readonly bytes: Uint8Array;
  position: number;
}

function readUnsigned(reader: Reader): number {
  let result = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = expectByte(reader);
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

function skipSigned(reader: Reader): void {
  let byte: number;
  do {
    byte = expectByte(reader);
  } while (byte & 0x80);
}

function expectByte(reader: Reader): number {
  if (reader.position >= reader.bytes.length) {
    throw new Error("wasm module ends inside an encoded value");
  }
  return reader.bytes[reader.position++];
}

function readName(reader: Reader): string {
  const length = readUnsigned(reader);
  const start = reader.position;
  reader.position += length;
  if (reader.position > reader.bytes.length) {
    throw new Error("wasm module ends inside a name");
  }
  return new TextDecoder().decode(reader.bytes.subarray(start, start + length));
}

function skipValueType(reader: Reader): void {
  const code = expectByte(reader);
  if (code === 0x63 || code === 0x64) skipSigned(reader);
}

function skipBlockType(reader: Reader): void {
  const code = reader.bytes[reader.position];
  if (code === 0x40) {
    reader.position++;
    return;
  }
  if (code < 0x40) {
    skipSigned(reader);
    return;
  }
  skipValueType(reader);
}

function skipLimits(reader: Reader): void {
  const flags = readUnsigned(reader);
  readUnsigned(reader);
  if (flags & 1) readUnsigned(reader);
}

function skipImportEntry(reader: Reader, functionImports: string[]): void {
  const module = readName(reader);
  const field = readName(reader);
  const kind = expectByte(reader);
  if (kind === EXTERNAL_KIND_FUNCTION) {
    readUnsigned(reader);
    functionImports.push(`${module}.${field}`);
  } else if (kind === EXTERNAL_KIND_TABLE) {
    skipValueType(reader);
    skipLimits(reader);
  } else if (kind === EXTERNAL_KIND_MEMORY) {
    skipLimits(reader);
  } else if (kind === EXTERNAL_KIND_GLOBAL) {
    skipValueType(reader);
    reader.position++;
  } else if (kind === EXTERNAL_KIND_TAG) {
    reader.position++;
    readUnsigned(reader);
  } else {
    throw new Error(`unknown import kind ${kind} on ${module}.${field}`);
  }
}

function skipInstructionImmediates(reader: Reader, opcode: number): void {
  if (opcode === OP_BLOCK || opcode === OP_LOOP || opcode === OP_IF) {
    skipBlockType(reader);
    return;
  }
  if (opcode === OP_BR_TABLE) {
    const targets = readUnsigned(reader);
    for (let i = 0; i <= targets; i++) readUnsigned(reader);
    return;
  }
  if (opcode === OP_SELECT_T) {
    const types = readUnsigned(reader);
    for (let i = 0; i < types; i++) skipValueType(reader);
    return;
  }
  if (opcode === OP_TRY_TABLE) {
    skipBlockType(reader);
    const catches = readUnsigned(reader);
    for (let i = 0; i < catches; i++) {
      const clause = expectByte(reader);
      if (clause === 0x00 || clause === 0x01) readUnsigned(reader);
      readUnsigned(reader);
    }
    return;
  }
  if (
    opcode === OP_THROW || opcode === 0x0c || opcode === 0x0d
    || (opcode >= 0x20 && opcode <= 0x26) || opcode === 0xd0 || opcode === 0xd2
  ) {
    readUnsigned(reader);
    return;
  }
  if (opcode >= 0x28 && opcode <= 0x3e) {
    readUnsigned(reader);
    readUnsigned(reader);
    return;
  }
  if (opcode === 0x3f || opcode === 0x40) {
    reader.position++;
    return;
  }
  if (opcode === 0x41 || opcode === 0x42) {
    skipSigned(reader);
    return;
  }
  if (opcode === 0x43) {
    reader.position += 4;
    return;
  }
  if (opcode === 0x44) {
    reader.position += 8;
    return;
  }
  if (opcode === 0xfc) {
    skipSaturatingOrBulkImmediates(reader);
    return;
  }
  if (opcode === 0xfb || opcode === 0xfd || opcode === 0xfe) {
    throw new Error(`opcode prefix 0x${opcode.toString(16)} is not decoded`);
  }
}

function skipSaturatingOrBulkImmediates(reader: Reader): void {
  const operation = readUnsigned(reader);
  if (operation <= 7) return;
  if (operation === 8 || operation === 10 || operation === 12 || operation === 14) {
    readUnsigned(reader);
    readUnsigned(reader);
    return;
  }
  readUnsigned(reader);
}

function locateExportedBody(
  bytes: Uint8Array,
  exportName: string,
): { readonly body: Reader; readonly bodyEnd: number; readonly functionImports: string[] } {
  if (bytes.length < 8) throw new Error("wasm module is too small to parse");

  const functionImports: string[] = [];
  let exportedIndex: number | null = null;
  let codeSection: { offset: number; end: number } | null = null;

  const reader: Reader = { bytes, position: 8 };
  while (reader.position < bytes.length) {
    const sectionId = expectByte(reader);
    const sectionSize = readUnsigned(reader);
    const contentOffset = reader.position;
    const contentEnd = contentOffset + sectionSize;
    if (contentEnd > bytes.length) throw new Error("wasm section runs past the module");

    if (sectionId === SECTION_IMPORT) {
      const count = readUnsigned(reader);
      for (let i = 0; i < count; i++) skipImportEntry(reader, functionImports);
    } else if (sectionId === SECTION_EXPORT) {
      const count = readUnsigned(reader);
      for (let i = 0; i < count; i++) {
        const name = readName(reader);
        const kind = expectByte(reader);
        const index = readUnsigned(reader);
        if (kind === EXTERNAL_KIND_FUNCTION && name === exportName) exportedIndex = index;
      }
    } else if (sectionId === SECTION_CODE) {
      codeSection = { offset: contentOffset, end: contentEnd };
    }

    reader.position = contentEnd;
  }

  if (exportedIndex === null) throw new Error(`module exports no function named ${exportName}`);
  if (codeSection === null) throw new Error("module has no code section");

  const definedIndex = exportedIndex - functionImports.length;
  if (definedIndex < 0) throw new Error(`${exportName} resolves to an imported function`);

  const body: Reader = { bytes, position: codeSection.offset };
  const bodyCount = readUnsigned(body);
  if (definedIndex >= bodyCount) throw new Error(`${exportName} has no body in the code section`);
  for (let i = 0; i < definedIndex; i++) {
    const size = readUnsigned(body);
    body.position += size;
  }
  const bodySize = readUnsigned(body);
  const bodyEnd = body.position + bodySize;
  if (bodyEnd > codeSection.end) throw new Error(`${exportName} body runs past the code section`);

  const localGroups = readUnsigned(body);
  for (let i = 0; i < localGroups; i++) {
    readUnsigned(body);
    skipValueType(body);
  }

  return { body, bodyEnd, functionImports };
}

export function readEntryCallSequence(
  programBytes: ArrayBuffer,
  exportName: string,
): WasmEntryCall[] {
  const { body, bodyEnd, functionImports } = locateExportedBody(
    new Uint8Array(programBytes),
    exportName,
  );

  const calls: WasmEntryCall[] = [];
  while (body.position < bodyEnd) {
    const opcode = expectByte(body);
    if (opcode === OP_CALL) {
      const callee = readUnsigned(body);
      calls.push({
        kind: "call",
        target: callee < functionImports.length ? functionImports[callee] : `func[${callee}]`,
      });
      continue;
    }
    if (opcode === OP_CALL_INDIRECT) {
      readUnsigned(body);
      readUnsigned(body);
      calls.push({ kind: "call_indirect" });
      continue;
    }
    skipInstructionImmediates(body, opcode);
  }

  if (body.position !== bodyEnd) {
    throw new Error(
      `${exportName} walk ended at ${body.position}, expected ${bodyEnd}`,
    );
  }
  return calls;
}
