// Generates the committed cross-language round-trip fixture used by the
// Rust `fork-codec` replay-events (KFRE) decoder tests under
// crates/fork-codec/testdata/replay-events-wasm32.bin.
//
// This is the drift guard for the replay-event journal wire format (the
// leaf-to-root activation event journal; see the mirrored constants in
// crates/shared/src/lib.rs `WPK_FORK_MODULE_STATE_REPLAY_EVENT*`): the fixture
// is emitted by the REAL TS journal/encoder (`ForkReplayEventJournal` in
// host/src/fork-replay-events.ts) via
// beginCapture/recordCommit/sealCapture and its
// capturedManifestPayload/capturedSegmentPayloads encoders, then a Rust test
// `include_bytes!`-loads it and asserts the manifest + segment chain decodes
// byte-for-byte.
//
// Unlike the linked-frame and module-state arenas, the replay-event wire is NOT
// a linear-memory pointer walk: it is a self-contained manifest byte array
// followed by an ordered sequence of segment byte arrays. The emitted fixture
// is the manifest bytes concatenated with the single captured segment's bytes
// (this small capture stays under one segment's 4080-event capacity, so there
// is exactly one segment). The Rust test splits at the fixed 40-byte manifest
// header size and hands the two halves to `decode_replay_events`.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-replay-events-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORK_REPLAY_EVENT_HEADER_SIZE,
  ForkReplayEventJournal,
} from "../../../host/src/fork-replay-events";

// Capture a small leaf-to-root activation event journal. recordCommit appends
// in capture (unwind) order; replay consumes the exact reverse. These are the
// same three events the host vitest suite drives, including a repeated
// activation id (3) and a distinct one (0), so the fixture exercises the
// activation-id set derivation as well as the raw entry layout.
const journal = new ForkReplayEventJournal();
journal.beginCapture();
journal.recordCommit(3, 8);
journal.recordCommit(3, 4);
journal.recordCommit(0, 11);
journal.sealCapture();

const manifest = journal.capturedManifestPayload();
const segments = [...journal.capturedSegmentPayloads()];

if (manifest.byteLength !== FORK_REPLAY_EVENT_HEADER_SIZE) {
  throw new Error(
    `fixture manifest expected ${FORK_REPLAY_EVENT_HEADER_SIZE} bytes, `
    + `got ${manifest.byteLength}`,
  );
}
if (segments.length !== 1) {
  throw new Error(
    `fixture expected a single replay-event segment, got ${segments.length}`,
  );
}

const segment = segments[0]!;
const fixture = new Uint8Array(manifest.byteLength + segment.byteLength);
fixture.set(manifest, 0);
fixture.set(segment, manifest.byteLength);

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "replay-events-wasm32.bin");
writeFileSync(outPath, fixture);

// Decode the entry layout so the Rust test can assert exact offsets/values.
const SEGMENT_HEADER_SIZE = 24;
const ENTRY_SIZE = 8;
const segmentView = new DataView(
  segment.buffer,
  segment.byteOffset,
  segment.byteLength,
);
const count = segmentView.getUint32(16, true);
const events: Array<Record<string, number>> = [];
for (let index = 0; index < count; index++) {
  const offset = SEGMENT_HEADER_SIZE + index * ENTRY_SIZE;
  events.push({
    index,
    activationId: segmentView.getUint32(offset, true),
    functionOrdinal: segmentView.getUint32(offset + 4, true),
  });
}

const manifestView = new DataView(
  manifest.buffer,
  manifest.byteOffset,
  manifest.byteLength,
);
const expected = {
  file: outPath,
  manifestSize: manifest.byteLength,
  segmentBytes: segment.byteLength,
  fixtureBytes: fixture.byteLength,
  segmentCount: manifestView.getBigUint64(24, true).toString(),
  eventCount: manifestView.getBigUint64(32, true).toString(),
  segmentSequence: segmentView.getBigUint64(8, true).toString(),
  segmentEntryCount: count,
  // Capture order (leaf-to-root); replay consumes the exact reverse.
  events,
};
console.log(JSON.stringify(expected, null, 2));
