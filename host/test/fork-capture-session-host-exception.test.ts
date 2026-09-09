// Capture-session host-exception parent-replay (deliverable 2 of the
// capture-session extraction).
//
// A2 found that the host-exception parent-replay path (`exceptionOwner` /
// `materializeHostException`, `FORK_HOST_EXCEPTION_ACTIVATION_ID`) routed
// through `recipeNode` -> the JS engine's node table, which is EMPTY under
// module capture — so it was latently broken there. The staying
// `ForkCaptureSession` fixes it by recording each exnref's owner at its capture
// site (`exceptionOwners`) and returning the parent's ORIGINAL live exception
// from `capturedValues`, both by construction rather than from a node table.
//
// This test drives a REAL co-resident `fork_module` capture graph
// (`fm_capture_*`) through a `ForkCaptureSession` and asserts:
//   (a) `exceptionOwner` reports the host owner for a captured host exception;
//   (b) `materializeHostException` on the PARENT's replay returns the ORIGINAL
//       exception with identity intact (NOT the owner-normalized child payload);
//   (c) a non-exception recipe is rejected loudly;
//   (d) abort resets the session so a fresh capture is unaffected.
//
// WebKit/browser confirmation of this path is deferred to the A6 batch gate
// (this is Node/V8 + the real fork_module artifact only).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkReferenceCaptureModule } from "../src/fork-reference-capture-module";
import { ForkCaptureSession } from "../src/fork-capture-session";
import { ForkFunctionCatalog } from "../src/fork-function-catalog";
import type { ForkExternrefRecipeProvider } from "../src/fork-reference-contracts";
import type { ForkModuleStateArena } from "../src/fork-module-state";
import { FORK_HOST_EXCEPTION_ACTIVATION_ID } from "../src/fork-reference-wire";

function newSession(): {
  session: ForkCaptureSession;
  handles: Map<number, unknown>;
} {
  const module = new WebAssembly.Module(
    readFileSync(resolveBinary("fork_module32.wasm")),
  );
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  let reserveBase = 8 * 1024 * 1024;
  const fm = instantiateForkModule({
    module,
    memory,
    ptrWidth: 4,
    reserve: (size: number): number => {
      const base = reserveBase;
      reserveBase += size;
      return base;
    },
    label: "host-exception-test",
  });
  const captureModule = new ForkReferenceCaptureModule(
    fm.exports,
    memory,
    "host-exception-test capture module",
  );
  // A minimal externref recipe provider: mint a fresh scalar handle per value
  // and remember the (handle -> value) mapping so identity can be checked.
  const handles = new Map<number, unknown>();
  let nextHandle = 1;
  const externrefs: ForkExternrefRecipeProvider = {
    capture(value: unknown): number {
      const handle = nextHandle++;
      handles.set(handle, value);
      return handle;
    },
    materialize(handle: number): unknown {
      return handles.get(handle);
    },
    tryEncode(): number | undefined {
      return undefined;
    },
  };
  const session = new ForkCaptureSession(
    new ForkFunctionCatalog(),
    externrefs,
    captureModule,
    undefined,
    undefined,
    memory,
  );
  return { session, handles };
}

// `sealInto` only appends records to the arena, so a minimal recording stub is
// a faithful stand-in for the (mmap-backed) module-state arena here.
function recordingArena(): ForkModuleStateArena {
  return { appendRecord(): void {} } as unknown as ForkModuleStateArena;
}

describe("ForkCaptureSession host-exception parent replay", () => {
  it("returns the ORIGINAL host exception to the parent with identity intact", () => {
    const { session } = newSession();
    session.beginCapture();

    // A raw host exception with a DISTINCT owner-normalized child payload: the
    // parent must recover the ORIGINAL, never the child payload.
    const original = { kind: "original host exception" };
    const childPayload = { kind: "owner-normalized child payload" };
    const recipeId = session.captureHostException(original, childPayload);
    expect(recipeId).toBeGreaterThan(0);

    session.sealInto(recordingArena());
    session.beginParentReplay();

    // (a) owner resolves to the host activation by construction (not an empty
    // node table).
    expect(session.exceptionOwner(recipeId)).toBe(
      FORK_HOST_EXCEPTION_ACTIVATION_ID,
    );
    // (b) the parent gets its ORIGINAL exception back, with identity intact.
    const materialized = session.materializeHostException(recipeId);
    expect(materialized).toBe(original);
    expect(materialized).not.toBe(childPayload);
    // Deduped: a second capture of the same value reuses the recipe id.
  });

  it("dedupes a repeated host exception to one recipe and one identity", () => {
    const { session } = newSession();
    session.beginCapture();
    const original = { kind: "reused host exception" };
    const first = session.captureHostException(original);
    const second = session.captureHostException(original);
    expect(second).toBe(first);
    session.sealInto(recordingArena());
    session.beginParentReplay();
    expect(session.materializeHostException(first)).toBe(original);
  });

  it("rejects a non-exception recipe loudly", () => {
    const { session } = newSession();
    session.beginCapture();
    // A funcref-free capture: recipe 0 is null; asking for its (nonexistent)
    // exception owner must fail loudly rather than silently mis-answering.
    session.sealInto(recordingArena());
    session.beginParentReplay();
    expect(() => session.exceptionOwner(1)).toThrow(/not an exception/);
  });

  it("preserves abort: a captured host exception is dropped on abort", () => {
    const { session } = newSession();
    session.beginCapture();
    session.captureHostException({ kind: "aborted" });
    session.abort();
    // A fresh capture on the same session starts clean (no leaked owner/cache).
    session.beginCapture();
    session.sealInto(recordingArena());
    session.beginParentReplay();
    expect(() => session.exceptionOwner(1)).toThrow(/not an exception/);
  });
});
