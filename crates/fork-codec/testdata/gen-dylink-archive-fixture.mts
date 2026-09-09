// Generates the committed cross-language fixture used by the Rust `fork-codec`
// KFLA dylink-fork-archive decoder tests under
// crates/fork-codec/testdata/dylink-archive-wasm32.bin.
//
// This is the drift guard for the KFLA dylink-fork archive memory image (see
// host/src/dylink-fork-archive.ts, `DylinkForkArchive`): the archive is written
// into a real `WebAssembly.Memory` by the REAL TypeScript writer via
// `sync` / `publishTableState` / `publishTablePatch`, the used prefix of that
// linear memory is captured verbatim, and the Rust test `include_bytes!`-loads
// it and asserts the header + every record decodes field-for-field.
//
// Unlike a flat KFRR/KFMS serializer, KFLA is a stateful writer that links
// records by absolute byte-offset pointers inside a live linear memory, so
// there is no standalone `encode()` function: we drive the real writer and
// snapshot its memory. As an in-generator sanity check we also re-decode the
// committed bytes with the real TS reader (`DylinkForkArchive.read`) so the
// bytes are self-consistent before Rust ever reads them.
//
// Regenerate with (from repo root):
//   cd host && npx tsx ../crates/fork-codec/testdata/gen-dylink-archive-fixture.mts
// (or via scripts/dev-shell.sh if tsx is not otherwise on PATH). This script
// only reads host/src; it adds and modifies nothing under host/.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DylinkForkArchive } from "../../../host/src/dylink-fork-archive";
import type { DylinkForkState } from "../../../host/src/dylink";

const PTR_WIDTH = 4 as const;
const MEMORY_PAGES = 4;
const MEMORY_BYTES = MEMORY_PAGES * 65_536;

const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES, maximum: MEMORY_PAGES });
let head = 0;
let next = 4096;
const live = new Map<number, number>();

const archive = new DylinkForkArchive(
  memory,
  PTR_WIDTH,
  () => head,
  (value) => {
    head = value;
  },
  (size) => {
    const address = next;
    next += Math.ceil(size / 8) * 8;
    live.set(address, size);
    return { address, size };
  },
  ({ address, size }) => {
    if (live.get(address) !== size) {
      throw new Error(`deallocate mismatch at ${address}`);
    }
    live.delete(address);
  },
  "gen dylink archive",
);

// A comprehensive published archive: one NEEDED dependency, one dlopen()ed
// consumer with a runtime provider edge + TLS + a committed GLOBAL root, and one
// module mid-initialization paired with a staged loader transaction. Exercises
// every KFLM field (bases, TLS, handle/refcount, allocations, provider deps,
// initialization) plus a KFLT transaction record.
const state: DylinkForkState = {
  nextHandle: 4,
  libraries: [
    {
      name: "libdependency.so",
      moduleBytes: new Uint8Array([0, 97, 115, 109, 1]),
      memoryBase: 8192,
      tableBase: 3,
      activationId: 7,
      globalVisibility: true,
      allocations: [
        { address: 8192, size: 64, mappingAddress: 8176, mappingSize: 95 },
      ],
    },
    {
      name: "libconsumer.so",
      moduleBytes: new Uint8Array([0, 97, 115, 109, 2]),
      memoryBase: 12288,
      tableBase: 9,
      activationId: 8,
      tlsBase: 16384,
      globalVisibility: true,
      committedGlobalRoot: true,
      providerDependencies: ["libdependency.so"],
      allocations: [
        { address: 12288, size: 128, mappingAddress: 12272, mappingSize: 159 },
      ],
      handle: 3,
      refCount: 2,
    },
    {
      name: "libinit.so",
      moduleBytes: new Uint8Array([0, 97, 115, 109, 43]),
      memoryBase: 20480,
      tableBase: 20,
      activationId: 9,
      globalVisibility: false,
      allocations: [
        { address: 20480, size: 64, mappingAddress: 20464, mappingSize: 95 },
      ],
      initialization: {
        transactionToken: 11,
        stage: "bootstrap",
        tableIndex: 19,
      },
    },
  ],
  transactions: [
    {
      token: 11,
      name: "libinit.so",
      moduleBytes: new Uint8Array([0, 97, 115, 109, 43]),
      globalVisibility: false,
    },
  ],
};

const first = archive.sync(state); // generation 1
archive.publishTableState(2048); // generation 2
const patch = {
  activationId: 7,
  ownerId: 3,
  start: 5,
  tableLength: 12,
  runs: [
    { length: 2, function: null },
    { length: 3, function: { activationId: 8, ordinal: 4 } },
  ],
} as const;
archive.publishTablePatch(patch); // generation 3

if (first.generation !== 1) {
  throw new Error(`unexpected first generation ${first.generation}`);
}

// In-generator cross-check: a fresh reader validates the committed image.
const reader = new DylinkForkArchive(
  memory,
  PTR_WIDTH,
  () => head,
  () => {
    throw new Error("reader must not publish");
  },
  () => {
    throw new Error("reader must not allocate");
  },
  () => {
    throw new Error("reader must not deallocate");
  },
  "gen dylink reader",
);
const snapshot = reader.read();
if (snapshot.generation !== 3 || snapshot.libraries.length !== 3) {
  throw new Error("cross-check reader disagreed with writer");
}

// Capture the used prefix of linear memory verbatim. Every record pointer is an
// absolute byte offset from 0, so the Rust test reconstitutes the full memory
// by zero-padding this prefix back out to MEMORY_BYTES.
const image = new Uint8Array(memory.buffer.slice(0, next));

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "dylink-archive-wasm32.bin");
writeFileSync(outPath, image);

console.log(
  JSON.stringify(
    {
      file: outPath,
      byteLength: image.byteLength,
      head,
      highWater: next,
      memoryBytes: MEMORY_BYTES,
      generation: snapshot.generation,
      nextHandle: snapshot.nextHandle,
      tableStateRoot: snapshot.tableStateRoot,
      tableCheckpointGeneration: snapshot.tableCheckpointGeneration,
      moduleCount: snapshot.libraries.length,
      modules: snapshot.libraries.map((lib) => ({
        name: lib.name,
        memoryBase: lib.memoryBase,
        tableBase: lib.tableBase,
        tlsBase: lib.tlsBase,
        activationId: lib.activationId,
        handle: lib.handle,
        refCount: lib.refCount,
        globalVisibility: lib.globalVisibility,
        committedGlobalRoot: lib.committedGlobalRoot,
        providerDependencies: lib.providerDependencies,
        allocations: lib.allocations,
        initialization: lib.initialization,
        moduleBytes: Array.from(lib.moduleBytes),
      })),
      transactions: snapshot.transactions?.map((t) => ({
        token: t.token,
        name: t.name,
        globalVisibility: t.globalVisibility,
        moduleBytes: Array.from(t.moduleBytes),
      })),
      tablePatches: snapshot.tablePatches,
    },
    null,
    2,
  ),
);
