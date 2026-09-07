// Shared test fixture: instantiate the co-resident `fork_module32.wasm` against
// a test's guest memory and wrap it as a `ForkReferenceCaptureModule`.
//
// After the fork-module kill-switch removal, the co-resident module is the
// UNCONDITIONAL fork reference engine — `ForkActivationRegistry.beginCapture`
// (and the peer-table capture) require it and there is no JS
// `ForkReferenceTransaction` fallback. Orchestration unit tests that used to
// drive the registry/coordinator through the in-process JS engine therefore
// wire a real capture module through this helper, exactly as a production
// worker does via `setCaptureModule`.
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkReferenceCaptureModule } from "../src/fork-reference-capture-module";

let cachedModule: WebAssembly.Module | undefined;

function forkModule32(): WebAssembly.Module {
  if (!cachedModule) {
    cachedModule = new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    );
  }
  return cachedModule;
}

/**
 * Instantiate the wasm32 fork-module HIGH in `memory` (never colliding with a
 * test's LOW bump arena, which starts near page 1) and return a
 * `ForkReferenceCaptureModule` bound to its exports. `memory` grows on demand to
 * cover the reserved region. Seeds the linked-frame format so the module can
 * size pointers for capture/serialize.
 */
export function installTestForkCaptureModule(
  memory: WebAssembly.Memory,
  label: string,
): ForkReferenceCaptureModule {
  // Reserve well above any unit fixture's arena; the module region is ~5.4 MiB.
  const PAGE = 65_536;
  const reserveBase = 32 * 1024 * 1024;
  const fm = instantiateForkModule({
    module: forkModule32(),
    memory,
    ptrWidth: 4,
    reserve: (size) => {
      // The test's guest memory starts small; grow it to cover the module's
      // HIGH region (production reserves via the syscall channel, which grows).
      const need = reserveBase + size;
      if (need > memory.buffer.byteLength) {
        memory.grow(Math.ceil((need - memory.buffer.byteLength) / PAGE));
      }
      return reserveBase;
    },
    label: `${label}: fork-module`,
  });
  // The backend's `setup()` seeds this in production; capture/serialize needs it
  // to size pointers.
  (fm.exports.fm_set_format as (ptrWidth: number, fixedPrefix: number) => void)(
    4,
    0,
  );
  return new ForkReferenceCaptureModule(fm.exports, memory, `${label}: capture module`);
}
