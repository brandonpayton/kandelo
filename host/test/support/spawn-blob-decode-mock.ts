import { vi } from "vitest";

import {
  POSIX_ARG_MAX_BYTES,
  POSIX_PATH_MAX_BYTES,
  SPAWN_MAX_ACTION_COUNT,
  SPAWN_MAX_ARGV_COUNT,
  SPAWN_MAX_ENVP_COUNT,
  SPAWN_WIRE_ACTION_OP_OFFSET,
  SPAWN_WIRE_ACTION_PATH_LEN_OFFSET,
  SPAWN_WIRE_ACTION_PATH_OFF_OFFSET,
  SPAWN_WIRE_ACTION_RECORD_BYTES,
  SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET,
  SPAWN_WIRE_HEADER_ARGC_OFFSET,
  SPAWN_WIRE_HEADER_BYTES,
  SPAWN_WIRE_HEADER_ENVC_OFFSET,
  SPAWN_WIRE_MAX_BYTES,
  SPAWN_WIRE_OP_CHDIR,
  SPAWN_WIRE_OP_CLOSE,
  SPAWN_WIRE_OP_DUP2,
  SPAWN_WIRE_OP_FCHDIR,
  SPAWN_WIRE_OP_OPEN,
  SPAWN_WIRE_STRING_OFFSET_BYTES,
} from "../../src/generated/abi";

const EINVAL = 22;
const E2BIG = 7;
const ENAMETOOLONG = 36;
const EOVERFLOW = 75;

/**
 * Faithful in-place JavaScript double for the kernel's
 * `kernel_spawn_blob_decode` export, for tests that supply mocked kernel
 * exports instead of a real kernel.
 *
 * It reproduces the kernel decode the host now depends on: read the SYS_SPAWN
 * blob from the front of the borrowed scratch range, structurally validate it
 * exactly like `crates/runtime-core/src/spawn.rs::parse_blob` (returning the
 * negated `Errno` the real kernel would), then overwrite that range in place
 * with the host-private framing `[argc u32][envc u32]` followed by every argv
 * entry and every envp entry as `[len u32][raw bytes]`. Returns the framed byte
 * length, or `-EOVERFLOW` when the framing exceeds the buffer — matching
 * `crates/kernel/src/wasm_api.rs::kernel_spawn_blob_decode` plus
 * `spawn.rs::{parse_blob, serialize_argv_envp}`.
 *
 * Validation faithfully mirrors `parse_blob`:
 *   - blob length > WIRE_MAX_BYTES            -> E2BIG
 *   - blob length < WIRE_HEADER_BYTES         -> EINVAL
 *   - argc/envc/n_actions past their caps     -> EINVAL (`==` cap admitted)
 *   - a truncated offset/action table         -> EINVAL
 *   - a string offset past the strings region -> EINVAL
 *   - a string with no terminating NUL        -> EINVAL
 *   - pointer-array ARG_MAX (4-byte pointers) -> E2BIG
 *   - aggregate represented ARG_MAX, measured incrementally so duplicate
 *     offsets never copy the repeated tail    -> E2BIG
 *   - a bad file-action path                  -> EINVAL / ENAMETOOLONG
 *
 * `parse_blob` always uses 4-byte pointer accounting regardless of the caller's
 * pointer width; the host's width-aware ARG_MAX stays with `validateExecMetadata`
 * after decode, and `parse_blob` enforces no per-entry byte cap (also
 * `validateExecMetadata`'s job).
 */
export function mockKernelSpawnBlobDecode(memory: WebAssembly.Memory) {
  return vi.fn(
    (
      bufPtr: number | bigint,
      bufCap: number | bigint,
      blobLen: number | bigint,
    ): number => {
      const ptr = Number(bufPtr);
      const cap = Number(bufCap);
      const len = Number(blobLen);

      // parse_blob checks the whole-blob ceiling before the header floor.
      if (len > SPAWN_WIRE_MAX_BYTES) return -E2BIG;
      if (len < SPAWN_WIRE_HEADER_BYTES) return -EINVAL;

      const bytes = new Uint8Array(memory.buffer, ptr, len);
      const view = new DataView(memory.buffer, ptr, len);
      const argc = view.getUint32(SPAWN_WIRE_HEADER_ARGC_OFFSET, true);
      const envc = view.getUint32(SPAWN_WIRE_HEADER_ENVC_OFFSET, true);
      const nActions = view.getUint32(
        SPAWN_WIRE_HEADER_ACTION_COUNT_OFFSET,
        true,
      );

      // Cap counts before touching the variable-length tables.
      if (
        argc > SPAWN_MAX_ARGV_COUNT
        || envc > SPAWN_MAX_ENVP_COUNT
        || nActions > SPAWN_MAX_ACTION_COUNT
      ) {
        return -EINVAL;
      }

      let cursor = SPAWN_WIRE_HEADER_BYTES;

      // Argv offsets table.
      const argvOffsetsEnd = cursor + argc * SPAWN_WIRE_STRING_OFFSET_BYTES;
      if (argvOffsetsEnd > len) return -EINVAL;
      const argvOffsets: number[] = [];
      for (let i = 0; i < argc; i++) {
        argvOffsets.push(
          view.getUint32(cursor + i * SPAWN_WIRE_STRING_OFFSET_BYTES, true),
        );
      }
      cursor = argvOffsetsEnd;

      // Envp offsets table.
      const envpOffsetsEnd = cursor + envc * SPAWN_WIRE_STRING_OFFSET_BYTES;
      if (envpOffsetsEnd > len) return -EINVAL;
      const envpOffsets: number[] = [];
      for (let i = 0; i < envc; i++) {
        envpOffsets.push(
          view.getUint32(cursor + i * SPAWN_WIRE_STRING_OFFSET_BYTES, true),
        );
      }
      cursor = envpOffsetsEnd;

      // Action records table.
      const actionsAt = cursor;
      const actionsEnd = cursor + nActions * SPAWN_WIRE_ACTION_RECORD_BYTES;
      if (actionsEnd > len) return -EINVAL;
      cursor = actionsEnd;

      // Everything after the action records is the strings region.
      const stringsAt = cursor;
      const stringsLen = len - stringsAt;

      // ARG_MAX accounts for the source pointer arrays. parse_blob always uses
      // four-byte pointers here regardless of caller width.
      const pointerBytes = (argc + envc + 2) * 4;
      if (pointerBytes > POSIX_ARG_MAX_BYTES) return -E2BIG;

      // Measure every referenced string against one incremental budget before
      // copying any bytes. WHY: duplicate offsets must be rejected by ARG_MAX
      // without ever allocating the repeated tail. Returns null on error (with
      // `errno` recorded) so a bad blob short-circuits to the negated errno.
      let errno = 0;
      let represented = pointerBytes;
      const measure = (offsets: number[]): Array<[number, number]> | null => {
        const ranges: Array<[number, number]> = [];
        for (const off of offsets) {
          if (off > stringsLen) {
            errno = EINVAL;
            return null;
          }
          let end = stringsAt + off;
          while (end < len && bytes[end] !== 0) end++;
          if (end >= len) {
            // No terminating NUL within the strings region.
            errno = EINVAL;
            return null;
          }
          const length = end - (stringsAt + off);
          represented += length + 1;
          if (represented > POSIX_ARG_MAX_BYTES) {
            errno = E2BIG;
            return null;
          }
          ranges.push([stringsAt + off, end]);
        }
        return ranges;
      };

      const argvRanges = measure(argvOffsets);
      if (argvRanges === null) return -errno;
      const envpRanges = measure(envpOffsets);
      if (envpRanges === null) return -errno;

      // Validate file-action records (unknown op / malformed path) exactly like
      // parse_blob; the framing carries argv/envp only, but a malformed action
      // still fails the whole decode.
      for (let i = 0; i < nActions; i++) {
        const base = actionsAt + i * SPAWN_WIRE_ACTION_RECORD_BYTES;
        const op = view.getUint32(base + SPAWN_WIRE_ACTION_OP_OFFSET, true);
        const pathOff = view.getUint32(
          base + SPAWN_WIRE_ACTION_PATH_OFF_OFFSET,
          true,
        );
        const pathLen = view.getUint32(
          base + SPAWN_WIRE_ACTION_PATH_LEN_OFFSET,
          true,
        );
        if (op === SPAWN_WIRE_OP_OPEN || op === SPAWN_WIRE_OP_CHDIR) {
          const pathErrno = validateActionPath(
            bytes,
            stringsAt,
            stringsLen,
            pathOff,
            pathLen,
          );
          if (pathErrno !== 0) return -pathErrno;
        } else if (
          op !== SPAWN_WIRE_OP_CLOSE
          && op !== SPAWN_WIRE_OP_DUP2
          && op !== SPAWN_WIRE_OP_FCHDIR
        ) {
          return -EINVAL;
        }
      }

      // Copy the measured strings out before the framing overwrites them.
      const entries: Uint8Array[] = [];
      for (const [start, end] of argvRanges) entries.push(bytes.slice(start, end));
      for (const [start, end] of envpRanges) entries.push(bytes.slice(start, end));

      let framed = 8;
      for (const entry of entries) framed += 4 + entry.byteLength;
      if (framed > cap) return -EOVERFLOW;

      const out = new Uint8Array(memory.buffer, ptr, cap);
      const outView = new DataView(memory.buffer, ptr, cap);
      outView.setUint32(0, argc, true);
      outView.setUint32(4, envc, true);
      let writeCursor = 8;
      for (const entry of entries) {
        outView.setUint32(writeCursor, entry.byteLength, true);
        writeCursor += 4;
        out.set(entry, writeCursor);
        writeCursor += entry.byteLength;
      }
      return writeCursor;
    },
  );
}

/**
 * Faithful port of `spawn.rs::read_action_path`: the referenced range must end
 * in exactly one terminal NUL, carry no interior NUL, and its path (excluding
 * the terminator) must be shorter than `POSIX_PATH_MAX_BYTES`. Returns `0` on
 * success or the negated-nothing errno the kernel would raise.
 */
function validateActionPath(
  bytes: Uint8Array,
  stringsAt: number,
  stringsLen: number,
  off: number,
  len: number,
): number {
  if (off + len > stringsLen) return EINVAL;
  if (len === 0) return EINVAL; // split_last on an empty slice
  const base = stringsAt + off;
  if (bytes[base + len - 1] !== 0) return EINVAL; // missing terminator
  for (let i = 0; i < len - 1; i++) {
    if (bytes[base + i] === 0) return EINVAL; // interior NUL
  }
  if (len - 1 >= POSIX_PATH_MAX_BYTES) return ENAMETOOLONG;
  return 0;
}
