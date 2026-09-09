// Generates the committed cross-language fixture that pins the STATEFUL replay
// event journal + resume-slot selection to the real TypeScript behavior, used by
// the Rust `fork-codec` replay-journal tests under
// crates/fork-codec/testdata/replay-journal-wasm32.bin.
//
// Unlike gen-replay-events-fixture.mts (which pins only the KFRE WIRE FORMAT),
// this fixture pins the *live logic* the D2 co-resident module ports: the
// `ForkReplayEventJournal` phase machine (recordCommit during unwind, then the
// leaf-to-root-reversed peek/consume replay cursor) AND `ForkResumeTable`
// slot selection (register/unregister slot allocation + reuse, then slotFor).
// See host/src/fork-replay-events.ts and
// .superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md
// "Frame-allocator hot loop".
//
// The fixture is emitted by driving the REAL classes: a journal capture, the
// real ForkResumeTable through a register/unregister/register op sequence (to
// exercise free-slot REUSE, the load-bearing part of the selection logic), then
// a full parent replay. The emitted golden is, in consume order, the exact
// (activationId, functionOrdinal, slot) sequence the real classes produce. The
// Rust test reconstructs the same inputs, drives its own journal + slot table,
// and asserts byte-for-byte agreement. If the Rust port and the TS classes ever
// disagree on replay order or slot assignment, the Rust test fails.
//
// The file is self-describing (all little-endian):
//   Section A - wire (so the Rust CHILD path decodes genuine TS-encoded bytes):
//     u32 manifest_len; manifest bytes;
//     u32 segment_count; { u32 seg_len; seg bytes } * segment_count
//   Section B - resume-table op log (applied in order to build the table):
//     u32 op_count;
//     { u32 kind (0=register,1=unregister); u32 activation_id;
//       if kind==0: u32 ordinal_count; u32 ordinal * ordinal_count } * op_count
//   Section C - replay golden (in consume order):
//     u32 event_count;
//     { u32 activation_id; u32 function_ordinal; u32 slot } * event_count
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-replay-journal-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ForkReplayEventJournal,
  ForkResumeTable,
  type ForkReplayEvent,
} from "../../../host/src/fork-replay-events";

// A single real exported Wasm function, reused as every resume thunk. The
// ForkResumeTable stores it in a genuine WebAssembly.Table (element anyfunc), so
// the thunk MUST be a real Wasm function, not a plain JS closure. Slot
// assignment does not depend on thunk identity, only on registration order, so
// one shared nop function is sufficient to drive real slot allocation.
const NOP_MODULE_BYTES = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
  0x03, 0x02, 0x01, 0x00, // func: one func of type 0
  0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, // export "f" func 0
  0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b, // code: one empty body
]);
const nopInstance = new WebAssembly.Instance(
  new WebAssembly.Module(NOP_MODULE_BYTES),
);
const nopThunk = nopInstance.exports.f as CallableFunction;

// --- Inputs -----------------------------------------------------------------

// Capture (leaf-to-root, unwind) order. Repeated activation ids (3, 0), several
// ordinals per activation, and a repeated (3,8) event exercise both the journal
// cursor and the slot lookup non-trivially. Replay consumes the exact reverse.
const captureOrder: ReadonlyArray<readonly [number, number]> = [
  [3, 8],
  [3, 4],
  [0, 11],
  [7, 2],
  [3, 8],
  [0, 5],
];

// Resume-table op log. Registering activation 9 then unregistering it frees its
// slots so activation 3's later registration REUSES them (smallest free slot
// first) — the free-slot reuse the Rust port must reproduce.
type Op =
  | { kind: "register"; activationId: number; ordinals: number[] }
  | { kind: "unregister"; activationId: number };
const ops: Op[] = [
  { kind: "register", activationId: 7, ordinals: [2] }, // slot 1
  { kind: "register", activationId: 9, ordinals: [1, 3] }, // slots 2, 3
  { kind: "unregister", activationId: 9 }, // frees slots {2, 3}
  { kind: "register", activationId: 3, ordinals: [8, 4] }, // sorted [4,8] reuse 2, 3
  { kind: "register", activationId: 0, ordinals: [5, 11] }, // slots 4, 5
];

// --- Drive the REAL classes -------------------------------------------------

const journal = new ForkReplayEventJournal();
journal.beginCapture();
for (const [activationId, functionOrdinal] of captureOrder) {
  journal.recordCommit(activationId, functionOrdinal);
}
journal.sealCapture();

// Encode the wire while still in a capture/sealed phase (the encoders require
// it), before parent replay flips the journal into the replay phase.
const manifest = journal.capturedManifestPayload();
const segments = [...journal.capturedSegmentPayloads()];

const table = new ForkResumeTable();
for (const op of ops) {
  if (op.kind === "register") {
    table.registerActivation(
      op.activationId,
      op.ordinals.map((functionOrdinal) => ({ functionOrdinal, thunk: nopThunk })),
    );
  } else {
    table.unregisterActivation(op.activationId);
  }
}

// Parent replay: peek -> slotFor -> consume, recording the golden sequence.
journal.beginParentReplay();
const golden: Array<{ activationId: number; functionOrdinal: number; slot: number }> = [];
for (;;) {
  const event: ForkReplayEvent | null = journal.peek();
  if (!event) break;
  const slot = table.slotFor(event);
  golden.push({
    activationId: event.activationId,
    functionOrdinal: event.functionOrdinal,
    slot,
  });
  journal.consume(event.activationId, event.functionOrdinal);
}
journal.finishReplay();

// --- Encode the self-describing fixture -------------------------------------

const chunks: Uint8Array[] = [];
function pushU32(value: number): void {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  chunks.push(bytes);
}

// Section A - wire.
pushU32(manifest.byteLength);
chunks.push(manifest);
pushU32(segments.length);
for (const segment of segments) {
  pushU32(segment.byteLength);
  chunks.push(segment);
}

// Section B - op log.
pushU32(ops.length);
for (const op of ops) {
  pushU32(op.kind === "register" ? 0 : 1);
  pushU32(op.activationId);
  if (op.kind === "register") {
    pushU32(op.ordinals.length);
    for (const ordinal of op.ordinals) pushU32(ordinal);
  }
}

// Section C - replay golden.
pushU32(golden.length);
for (const entry of golden) {
  pushU32(entry.activationId);
  pushU32(entry.functionOrdinal);
  pushU32(entry.slot);
}

const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
const fixture = new Uint8Array(total);
let offset = 0;
for (const chunk of chunks) {
  fixture.set(chunk, offset);
  offset += chunk.byteLength;
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "replay-journal-wasm32.bin");
writeFileSync(outPath, fixture);

console.log(
  JSON.stringify(
    {
      file: outPath,
      fixtureBytes: fixture.byteLength,
      manifestBytes: manifest.byteLength,
      segmentCount: segments.length,
      opCount: ops.length,
      goldenCount: golden.length,
      golden,
    },
    null,
    2,
  ),
);
