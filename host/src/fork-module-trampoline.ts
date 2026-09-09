// Per-activation fork-frame TRAMPOLINE synthesizer (Phase 6 D7a.1a-host).
//
// A dlopen fork has N ACTIVATIONS: activation 0 is the main module, activations
// 1..N are the dlopen'd side modules. Each activation's guest code imports the
// SAME frozen guest-facing frame ABI —
//   __wpk_fork_frame_reserve(size)      -> payload
//   __wpk_fork_frame_commit(payload)
//   __wpk_fork_frame_peek(size)         -> payload
//   __wpk_fork_frame_next(size)         -> payload
//   __wpk_fork_resume_peek(diagnostic)  -> slot
// — but its frames must route to that activation's OWN per-activation writer /
// rewind driver inside the single shared co-resident fork-module.
//
// The shared fork-module exposes ACTIVATION-PARAMETERIZED shared exports
//   fm_frame_reserve(act, size) / fm_frame_commit(act, payload) /
//   fm_frame_peek(act, size)    / fm_frame_next(act, size) /
//   fm_resume_peek(act)
// keyed by activation id. This synthesizer emits, per activation id, a TINY wasm
// TRAMPOLINE module whose exports carry the frozen guest-facing names and whose
// bodies fold in a constant activation-id immediate before delegating to the
// shared export:
//
//   (func (export "__wpk_fork_frame_reserve") (param $size i32) (result i32)
//     (call $shared.fm_frame_reserve (i32.const <act>) (local.get $size)))
//
// The guest imports THIS trampoline's exports (unchanged names + signatures, so
// no guest re-instrumentation); the trampoline imports the shared module's
// `shared.fm_frame_*` exports. Result: wasm->wasm routing of each activation's
// frame calls to a shared export carrying the activation-id immediate. The
// activation count is dynamic and uncapped — one trampoline per activation id.
//
// This is a HAND-ROLLED fixed-shape byte emitter (no toolchain dependency): the
// production TypeScript port of the reference spike at
// `crates/fork-module/tests/fork-trampoline.mjs`. The trampoline forwards only
// scalars, so it imports nothing but the shared frame exports (no `env.memory`
// needed — the shared module owns the memory import).

import type { ForkModuleExports } from "./fork-module-instance";

const SHARED_MODULE = "shared";

// -- LEB128 encoders --------------------------------------------------------
function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

function sleb(value: number): number[] {
  // Signed LEB128 for i32.const. Activation ids are small non-negative, but
  // encode fully-general so any i32 activation id is representable.
  const out: number[] = [];
  let v = value | 0;
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0)) {
      more = false;
    } else {
      byte |= 0x80;
    }
    out.push(byte);
  }
  return out;
}

const utf8 = new TextEncoder();
function name(str: string): number[] {
  const bytes = Array.from(utf8.encode(str));
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

// Wasm value type + function-type helpers.
const I32 = 0x7f;
function funcType(params: number[], results: number[]): number[] {
  return [0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results];
}

/**
 * Emit the trampoline module bytes for one activation id.
 *
 * @param activationId the activation whose frames these exports route
 * @returns a complete wasm module importing `shared.fm_frame_*` and exporting
 *   the frozen guest-facing `__wpk_fork_frame_*` names.
 */
export function emitTrampoline(activationId: number): Uint8Array {
  // Type indices.
  const T_I32I32_I32 = 0; // (act, size) -> i32   : reserve / peek / next (shared)
  const T_I32I32_VOID = 1; // (act, payload) -> () : commit (shared)
  const T_I32_I32 = 2; // (i32) -> i32          : resume_peek (shared) + guest reserve/peek/next/resume
  const T_I32_VOID = 3; // (i32) -> ()           : guest commit

  const types = section(0x01, [
    ...uleb(4),
    ...funcType([I32, I32], [I32]),
    ...funcType([I32, I32], []),
    ...funcType([I32], [I32]),
    ...funcType([I32], []),
  ]);

  // Imports: the shared module's activation-parameterized frame exports. Import
  // function indices are assigned in declaration order (0..4).
  const importEntry = (fn: string, typeIdx: number): number[] => [
    ...name(SHARED_MODULE),
    ...name(fn),
    0x00, // import kind: function
    ...uleb(typeIdx),
  ];
  const IMP_RESERVE = 0;
  const IMP_COMMIT = 1;
  const IMP_PEEK = 2;
  const IMP_NEXT = 3;
  const IMP_RESUME = 4;
  const imports = section(0x02, [
    ...uleb(5),
    ...importEntry("fm_frame_reserve", T_I32I32_I32),
    ...importEntry("fm_frame_commit", T_I32I32_VOID),
    ...importEntry("fm_frame_peek", T_I32I32_I32),
    ...importEntry("fm_frame_next", T_I32I32_I32),
    ...importEntry("fm_resume_peek", T_I32_I32),
  ]);

  // Local functions (indices continue after the 5 imports: 5..9).
  const funcs = section(0x03, [
    ...uleb(5),
    ...uleb(T_I32_I32), // __wpk_fork_frame_reserve
    ...uleb(T_I32_VOID), // __wpk_fork_frame_commit
    ...uleb(T_I32_I32), // __wpk_fork_frame_peek
    ...uleb(T_I32_I32), // __wpk_fork_frame_next
    ...uleb(T_I32_I32), // __wpk_fork_resume_peek
  ]);

  const FN_RESERVE = 5;
  const FN_COMMIT = 6;
  const FN_PEEK = 7;
  const FN_NEXT = 8;
  const FN_RESUME = 9;
  const exportEntry = (fn: string, funcIdx: number): number[] => [
    ...name(fn),
    0x00,
    ...uleb(funcIdx),
  ];
  const exports = section(0x07, [
    ...uleb(5),
    ...exportEntry("__wpk_fork_frame_reserve", FN_RESERVE),
    ...exportEntry("__wpk_fork_frame_commit", FN_COMMIT),
    ...exportEntry("__wpk_fork_frame_peek", FN_PEEK),
    ...exportEntry("__wpk_fork_frame_next", FN_NEXT),
    ...exportEntry("__wpk_fork_resume_peek", FN_RESUME),
  ]);

  // Instruction opcodes.
  const I32_CONST = 0x41;
  const LOCAL_GET = 0x20;
  const CALL = 0x10;
  const END = 0x0b;

  const actConst = [I32_CONST, ...sleb(activationId)];
  // A (act, param0)-forwarding body: i32.const act; local.get 0; call <import>.
  const forward2 = (importIdx: number): number[] => [
    ...actConst,
    LOCAL_GET,
    0x00,
    CALL,
    ...uleb(importIdx),
    END,
  ];
  // A (act)-only body (resume_peek drops the guest's diagnostic arg):
  // i32.const act; call <import>.
  const forward1 = (importIdx: number): number[] => [
    ...actConst,
    CALL,
    ...uleb(importIdx),
    END,
  ];

  const funcBody = (instrs: number[]): number[] => {
    const body = [...uleb(0), ...instrs]; // 0 local declarations
    return [...uleb(body.length), ...body];
  };
  const code = section(0x0a, [
    ...uleb(5),
    ...funcBody(forward2(IMP_RESERVE)),
    ...funcBody(forward2(IMP_COMMIT)),
    ...funcBody(forward2(IMP_PEEK)),
    ...funcBody(forward2(IMP_NEXT)),
    ...funcBody(forward1(IMP_RESUME)),
  ]);

  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  return new Uint8Array([...header, ...types, ...imports, ...funcs, ...exports, ...code]);
}

/**
 * Instantiate a per-activation trampoline against a shared fork-module instance.
 * The trampoline's `shared.*` imports are wired to the shared instance's
 * activation-parameterized exports; the returned exports carry the frozen
 * guest-facing `__wpk_fork_frame_*` names for that activation.
 */
export function instantiateTrampoline(
  sharedExports: ForkModuleExports,
  activationId: number,
): WebAssembly.Instance {
  const bytes = emitTrampoline(activationId);
  const module = new WebAssembly.Module(bytes as unknown as BufferSource);
  return new WebAssembly.Instance(module, {
    [SHARED_MODULE]: {
      fm_frame_reserve: sharedExports.fm_frame_reserve as WebAssembly.ImportValue,
      fm_frame_commit: sharedExports.fm_frame_commit as WebAssembly.ImportValue,
      fm_frame_peek: sharedExports.fm_frame_peek as WebAssembly.ImportValue,
      fm_frame_next: sharedExports.fm_frame_next as WebAssembly.ImportValue,
      fm_resume_peek: sharedExports.fm_resume_peek as WebAssembly.ImportValue,
    },
  });
}

/**
 * The five frozen guest-facing frame/resume import bindings for one activation,
 * routed through its per-activation trampoline. These replace exactly the five
 * per-frame JS closures from `ForkProcessContinuationCoordinator.continuationImports`
 * when a fork qualifies for the module path; everything else that method returns
 * (crucially the JS `__wpk_fork_resume_table` funcref table) is kept.
 */
export interface ForkTrampolineFrameImports {
  __wpk_fork_frame_reserve: WebAssembly.ImportValue;
  __wpk_fork_frame_commit: WebAssembly.ImportValue;
  __wpk_fork_frame_peek: WebAssembly.ImportValue;
  __wpk_fork_frame_next: WebAssembly.ImportValue;
  __wpk_fork_resume_peek: WebAssembly.ImportValue;
}

/**
 * Owns one shared fork-module instance's per-activation trampolines.
 *
 * A dlopen fork flips EVERY activation's five frozen frame/resume imports to
 * that activation's trampoline (wasm->wasm), so each activation's frames route
 * to its own writer/driver in the single shared module while the journal +
 * resume table stay process-wide. Instances are cached per activation id and
 * evicted when the coordinator unregisters an activation.
 */
export class ForkModuleTrampolines {
  private readonly cache = new Map<number, WebAssembly.Instance>();

  constructor(private readonly sharedExports: ForkModuleExports) {}

  /** The cached (or freshly synthesized) trampoline instance for `activationId`. */
  instanceFor(activationId: number): WebAssembly.Instance {
    let instance = this.cache.get(activationId);
    if (!instance) {
      instance = instantiateTrampoline(this.sharedExports, activationId);
      this.cache.set(activationId, instance);
    }
    return instance;
  }

  /**
   * The five frozen guest-facing frame/resume import bindings for `activationId`,
   * folding the activation id into each shared-export call.
   */
  frameImportsFor(activationId: number): ForkTrampolineFrameImports {
    const exports = this.instanceFor(activationId).exports;
    return {
      __wpk_fork_frame_reserve: exports.__wpk_fork_frame_reserve as WebAssembly.ImportValue,
      __wpk_fork_frame_commit: exports.__wpk_fork_frame_commit as WebAssembly.ImportValue,
      __wpk_fork_frame_peek: exports.__wpk_fork_frame_peek as WebAssembly.ImportValue,
      __wpk_fork_frame_next: exports.__wpk_fork_frame_next as WebAssembly.ImportValue,
      __wpk_fork_resume_peek: exports.__wpk_fork_resume_peek as WebAssembly.ImportValue,
    };
  }

  /** Evict a trampoline (called when its activation is unregistered). */
  evict(activationId: number): void {
    this.cache.delete(activationId);
  }
}
