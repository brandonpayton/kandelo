// Path B P3: the thin host adapter that lets `ForkReferenceTransaction` route
// reference CAPTURE through the co-resident fork-module's shared
// `fork_codec::ReferenceGraphBuilder` (the `fm_capture_*` exports) instead of
// building a parallel JavaScript capture graph. This is the encode-side mirror
// of the decode/data-feed flip already wired for the child reconstruction: the
// module becomes the SOLE capture graph on V8, exactly as native's `guest.rs`
// capture bodies call `graph.intern_*`.
//
// Every method is PURE SCALAR at the module boundary — the module never sees a
// live reference. The transaction resolves each live value to its recipe
// COORDINATE (funcref catalog ordinal, externref broker handle, i31 payload,
// static-root coordinate) with the irreducible per-host identity floor (the V8
// `WeakMap` provenance + the transit table) and passes only the coordinate here.
//
// This module is "staying glue" (like `fork-module-instance.ts` /
// `-backend.ts`): it drives the module and survives the P6 deletion of the JS
// reconstruction twins.

import type { ForkModuleExports } from "./fork-module-instance";

/** One drained KFRV/KFRS record the host appends to its module-state arena. */
export interface ForkCaptureRecord {
  kind: number;
  activationId: number;
  ownerId: number;
  payload: Uint8Array;
}

/** GC aggregate kind discriminants `defineGc` accepts (mirror the module). */
export const FORK_CAPTURE_KIND_STRUCT = 1;
export const FORK_CAPTURE_KIND_ARRAY = 2;

/**
 * Thin, stateful wrapper over the `fm_capture_*` exports of ONE resident
 * fork-module instance. All interning goes through the shared Rust builder; the
 * wrapper only translates the module's `-1`/errno convention into a thrown host
 * error so a capture fault fails loud rather than silently mis-capturing.
 */
export class ForkReferenceCaptureModule {
  constructor(
    private readonly exports: ForkModuleExports,
    private readonly memory: WebAssembly.Memory,
    private readonly label = "fork reference capture module",
  ) {}

  private get fn(): Record<string, (...args: number[]) => number> {
    return this.exports as unknown as Record<
      string,
      (...args: number[]) => number
    >;
  }

  private lastErrno(): number {
    return this.fn.fm_last_errno();
  }

  private requireId(result: number, op: string): number {
    if (result < 0) {
      throw new Error(
        `${this.label}: ${op} failed (errno ${this.lastErrno()})`,
      );
    }
    return result;
  }

  private requireOk(result: number, op: string): void {
    if (result < 0) {
      throw new Error(
        `${this.label}: ${op} failed (errno ${this.lastErrno()})`,
      );
    }
  }

  /** Seed a fresh capture session (recipe 0 = null, vector 0 = empty). */
  begin(): void {
    this.fn.fm_capture_begin();
  }

  internFuncref(activation: number, ordinal: number): number {
    return this.requireId(
      this.fn.fm_capture_intern_funcref(activation >>> 0, ordinal >>> 0),
      "intern funcref",
    );
  }

  internExternref(handle: number): number {
    return this.requireId(
      this.fn.fm_capture_intern_externref(handle >>> 0),
      "intern externref",
    );
  }

  internI31(value: number): number {
    return this.requireId(this.fn.fm_capture_intern_i31(value | 0), "intern i31");
  }

  internStaticRoot(activation: number, ordinal: number): number {
    return this.requireId(
      this.fn.fm_capture_intern_static_root(activation >>> 0, ordinal >>> 0),
      "intern static root",
    );
  }

  claimGc(): number {
    return this.requireId(this.fn.fm_capture_claim_gc(), "claim gc");
  }

  gatedPlaceholder(): number {
    return this.requireId(
      this.fn.fm_capture_gated_placeholder(),
      "reserve gated placeholder",
    );
  }

  /**
   * Complete a claimed struct/array placeholder. `scalarPtr`/`scalarLen` are the
   * COMBINED scalar bytes (constructor-provenance seed then the live field
   * snapshot) already laid out in guest linear memory by the caller;
   * `referenceVectorOrdinal` names the module-interned field/element vector; and
   * `provPtr`/`provCount` (when `hasProvenance`) are the provenance recipe ids in
   * memory. The module reads the field vector internally and prepends the
   * provenance ids, exactly as native's `gc_define` assembles its edges.
   */
  defineGc(args: {
    recipeId: number;
    activation: number;
    typeOrdinal: number;
    layoutId: number;
    kind: number;
    scalarPtr: number;
    scalarLen: number;
    referenceVectorOrdinal: number;
    hasProvenance: boolean;
    provPtr: number;
    provCount: number;
  }): void {
    this.requireOk(
      this.fn.fm_capture_define_gc(
        args.recipeId >>> 0,
        args.activation >>> 0,
        args.typeOrdinal >>> 0,
        args.layoutId >>> 0,
        args.kind >>> 0,
        args.scalarPtr >>> 0,
        args.scalarLen >>> 0,
        args.referenceVectorOrdinal >>> 0,
        args.hasProvenance ? 1 : 0,
        args.provPtr >>> 0,
        args.provCount >>> 0,
      ),
      "define gc",
    );
  }

  beginVector(): number {
    return this.requireId(this.fn.fm_capture_begin_vector(), "begin vector");
  }

  appendVector(handle: number, recipeId: number): void {
    this.requireOk(
      this.fn.fm_capture_append_vector(handle >>> 0, recipeId >>> 0),
      "append vector",
    );
  }

  finishVector(handle: number): number {
    return this.requireId(
      this.fn.fm_capture_finish_vector(handle >>> 0),
      "finish vector",
    );
  }

  validate(): void {
    this.requireOk(this.fn.fm_capture_validate(), "validate capture");
  }

  /**
   * Serialize the built graph and drain the KFRV/KFRS record stream into host
   * `ForkCaptureRecord`s the caller appends to its module-state arena. The
   * manifest is the LAST record. `ownerId` is the reference-transaction owner;
   * `segmentWindow` is the per-segment copy window (bytes).
   */
  serializeRecords(ownerId: number, segmentWindow: number): ForkCaptureRecord[] {
    const ptr = this.fn.fm_capture_serialize(ownerId >>> 0, segmentWindow >>> 0);
    if (ptr === 0) {
      throw new Error(
        `${this.label}: serialize failed (errno ${this.lastErrno()})`,
      );
    }
    const len = this.fn.fm_capture_serialized_len();
    const header = this.fn.fm_capture_record_header_size();
    const view = new DataView(this.memory.buffer);
    const bytes = new Uint8Array(this.memory.buffer);
    const records: ForkCaptureRecord[] = [];
    let off = ptr;
    const end = ptr + len;
    while (off < end) {
      const kind = view.getUint16(off, true);
      const activationId = view.getUint32(off + 4, true);
      const recordOwner = view.getUint32(off + 8, true);
      const payloadLen = view.getUint32(off + 12, true);
      const payloadStart = off + header;
      // Copy out into a fresh (non-shared) buffer: the module's backing Vec may
      // move on the next capture, and the arena wants an owned Uint8Array.
      const payload = new Uint8Array(payloadLen);
      payload.set(bytes.subarray(payloadStart, payloadStart + payloadLen));
      records.push({ kind, activationId, ownerId: recordOwner, payload });
      off = payloadStart + payloadLen;
    }
    if (off !== end) {
      throw new Error(`${this.label}: serialized record stream is malformed`);
    }
    return records;
  }

  /**
   * Read entry `index` of interned reference vector `ordinal` from the RESIDENT
   * capture builder — the PARENT's own post-fork replay read (see the module's
   * `fm_capture_vector_get`). Returns the recipe id.
   */
  vectorGet(ordinal: number, index: number): number {
    return this.requireId(
      this.fn.fm_capture_vector_get(ordinal >>> 0, index >>> 0),
      "read capture vector",
    );
  }

  /** The module's interned proof-of-use counter (coordinates interned). */
  interned(): number {
    return this.fn.fm_capture_interned();
  }
}
