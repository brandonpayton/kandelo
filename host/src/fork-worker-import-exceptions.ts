import {
  defineForkExternrefImport,
  type ForkExternrefImportBinding,
  type ForkExternrefImportDescriptor,
  ForkExternrefImportOwnerCatalog,
  type ForkExternrefImportValue,
  ForkExternrefImportWorkerCaller,
} from "./fork-externref-import-mailbox";
import {
  createForkWorkerExceptionCapability,
  FORK_WORKER_EXCEPTION_RECIPE_VERSION,
  type ForkWorkerExceptionCapability,
  type ForkWorkerExceptionKind,
} from "./fork-worker-exception-capability";
import {
  type ForkExternrefToken,
  ForkExternrefTokenCache,
} from "./fork-reference-broker";

const NORMALIZE_BEGIN_ORDINAL = 0xffff_fffc;
const NORMALIZE_CHUNK_ORDINAL = 0xffff_fffd;
const NORMALIZE_COMMIT_ORDINAL = 0xffff_fffe;
const NORMALIZE_ABORT_ORDINAL = 0xffff_ffff;
const CHUNK_WORDS = 13;
const CODE_UNITS_PER_WORD = 4;
const CHUNK_CODE_UNITS = CHUNK_WORDS * CODE_UNITS_PER_WORD;
const MAX_SESSION_ID = 0x7fff_fffe;
export const FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL = 0x7fff_ffff;

export const FORK_WORKER_EXCEPTION_RESERVED_ORDINAL_START =
  NORMALIZE_BEGIN_ORDINAL;

export const FORK_WORKER_EXCEPTION_BEGIN_DESCRIPTOR =
  defineForkExternrefImport(
    NORMALIZE_BEGIN_ORDINAL,
    ["i32", "i32", "i32", "i32", "i64", "i32", "i32"],
    ["i32"],
  );

export const FORK_WORKER_EXCEPTION_CHUNK_DESCRIPTOR =
  defineForkExternrefImport(
    NORMALIZE_CHUNK_ORDINAL,
    [
      "i32",
      "i32",
      "i32",
      ...Array(CHUNK_WORDS).fill("i64"),
    ] as const,
    [],
  );

export const FORK_WORKER_EXCEPTION_COMMIT_DESCRIPTOR =
  defineForkExternrefImport(
    NORMALIZE_COMMIT_ORDINAL,
    ["i32"],
    ["externref"],
  );

export const FORK_WORKER_EXCEPTION_ABORT_DESCRIPTOR =
  defineForkExternrefImport(
    NORMALIZE_ABORT_ORDINAL,
    ["i32"],
    [],
  );

const enum ExceptionKindCode {
  Undefined = 1,
  Null = 2,
  Boolean = 3,
  Number = 4,
  BigInt = 5,
  String = 6,
  Symbol = 7,
  Error = 8,
  Object = 9,
  Function = 10,
}

const FLAG_BOOLEAN_TRUE = 1 << 0;
const FLAG_SYMBOL_GLOBAL = 1 << 0;
const FLAG_SYMBOL_HAS_DESCRIPTION = 1 << 1;

interface WorkerExceptionRecipe {
  readonly kind: ExceptionKindCode;
  readonly flags: number;
  readonly scalarBits: bigint;
  readonly fields: readonly [string, string];
}

interface OwnerExceptionSession {
  readonly binding: ForkExternrefImportBinding;
  readonly sourceImportOrdinal: number;
  readonly kind: ExceptionKindCode;
  readonly flags: number;
  readonly scalarBits: bigint;
  readonly expectedLengths: readonly [number, number];
  readonly chunks: [string[], string[]];
  receivedLengths: [number, number];
}

function sameBinding(
  left: ForkExternrefImportBinding,
  right: ForkExternrefImportBinding,
): boolean {
  return (
    left.pid === right.pid
    && left.generationId === right.generationId
    && left.senderId === right.senderId
  );
}

function assertI32(value: unknown, label: string): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < -0x8000_0000
    || value > 0x7fff_ffff
  ) {
    throw new TypeError(`${label} must be an i32`);
  }
  return value;
}

function assertNonnegativeI32(value: unknown, label: string): number {
  const checked = assertI32(value, label);
  if (checked < 0) throw new RangeError(`${label} must be nonnegative`);
  return checked;
}

function assertI64(value: unknown, label: string): bigint {
  if (typeof value !== "bigint") {
    throw new TypeError(`${label} must be an i64`);
  }
  return value;
}

function kindName(code: ExceptionKindCode): ForkWorkerExceptionKind {
  switch (code) {
    case ExceptionKindCode.Undefined:
      return "undefined";
    case ExceptionKindCode.Null:
      return "null";
    case ExceptionKindCode.Boolean:
      return "boolean";
    case ExceptionKindCode.Number:
      return "number";
    case ExceptionKindCode.BigInt:
      return "bigint";
    case ExceptionKindCode.String:
      return "string";
    case ExceptionKindCode.Symbol:
      return "symbol";
    case ExceptionKindCode.Error:
      return "error";
    case ExceptionKindCode.Object:
      return "object";
    case ExceptionKindCode.Function:
      return "function";
    default:
      throw new RangeError(`unknown Worker exception kind ${code}`);
  }
}

function exactNumberBits(value: number): bigint {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return view.getBigInt64(0, true);
}

function numberFromExactBits(bits: bigint): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigInt64(0, bits, true);
  return view.getFloat64(0, true);
}

function readStringDataProperty(
  value: object,
  name: "name" | "message",
): string | undefined {
  let current: object | null = value;
  // Avoid invoking arbitrary getters while normalizing an already failing
  // import. Standard Error name/message properties are data descriptors.
  for (let depth = 0; current !== null && depth < 32; depth++) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor && "value" in descriptor) {
        return typeof descriptor.value === "string"
          ? descriptor.value
          : undefined;
      }
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isErrorObject(value: object): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function describeThrown(value: unknown): WorkerExceptionRecipe {
  switch (typeof value) {
    case "undefined":
      return {
        kind: ExceptionKindCode.Undefined,
        flags: 0,
        scalarBits: 0n,
        fields: ["", ""],
      };
    case "boolean":
      return {
        kind: ExceptionKindCode.Boolean,
        flags: value ? FLAG_BOOLEAN_TRUE : 0,
        scalarBits: 0n,
        fields: ["", ""],
      };
    case "number":
      return {
        kind: ExceptionKindCode.Number,
        flags: 0,
        scalarBits: exactNumberBits(value),
        fields: ["", ""],
      };
    case "bigint":
      return {
        kind: ExceptionKindCode.BigInt,
        flags: 0,
        scalarBits: 0n,
        fields: [value.toString(10), ""],
      };
    case "string":
      return {
        kind: ExceptionKindCode.String,
        flags: 0,
        scalarBits: 0n,
        fields: [value, ""],
      };
    case "symbol": {
      const globalKey = Symbol.keyFor(value);
      const description = value.description;
      return {
        kind: ExceptionKindCode.Symbol,
        flags:
          (globalKey === undefined ? 0 : FLAG_SYMBOL_GLOBAL)
          | (description === undefined ? 0 : FLAG_SYMBOL_HAS_DESCRIPTION),
        scalarBits: 0n,
        fields: [globalKey ?? description ?? "", ""],
      };
    }
    case "function":
      return {
        kind: ExceptionKindCode.Function,
        flags: 0,
        scalarBits: 0n,
        fields: ["", ""],
      };
    case "object":
      if (value === null) {
        return {
          kind: ExceptionKindCode.Null,
          flags: 0,
          scalarBits: 0n,
          fields: ["", ""],
        };
      }
      if (isErrorObject(value)) {
        return {
          kind: ExceptionKindCode.Error,
          flags: 0,
          scalarBits: 0n,
          fields: [
            readStringDataProperty(value, "name") ?? "Error",
            readStringDataProperty(value, "message") ?? "",
          ],
        };
      }
      return {
        kind: ExceptionKindCode.Object,
        flags: 0,
        scalarBits: 0n,
        fields: ["", ""],
      };
  }
}

function packCodeUnits(
  value: string,
  offset: number,
): bigint[] {
  const words: bigint[] = [];
  for (let wordIndex = 0; wordIndex < CHUNK_WORDS; wordIndex++) {
    let word = 0n;
    for (
      let codeUnitIndex = 0;
      codeUnitIndex < CODE_UNITS_PER_WORD;
      codeUnitIndex++
    ) {
      const index =
        offset + wordIndex * CODE_UNITS_PER_WORD + codeUnitIndex;
      const codeUnit = index < value.length ? value.charCodeAt(index) : 0;
      word |= BigInt(codeUnit) << BigInt(codeUnitIndex * 16);
    }
    words.push(BigInt.asIntN(64, word));
  }
  return words;
}

function unpackCodeUnits(
  words: readonly bigint[],
  count: number,
): string {
  const codeUnits: number[] = [];
  for (const signedWord of words) {
    const word = BigInt.asUintN(64, signedWord);
    for (let index = 0; index < CODE_UNITS_PER_WORD; index++) {
      codeUnits.push(
        Number((word >> BigInt(index * 16)) & 0xffffn),
      );
    }
  }
  for (let index = count; index < codeUnits.length; index++) {
    if (codeUnits[index] !== 0) {
      throw new Error("Worker exception chunk has nonzero padding");
    }
  }
  return String.fromCharCode(...codeUnits.slice(0, count));
}

function validateRecipeShape(
  kind: ExceptionKindCode,
  flags: number,
  fieldLengths: readonly [number, number],
): void {
  kindName(kind);
  if (!Number.isInteger(flags) || flags < 0) {
    throw new RangeError("Worker exception recipe flags are invalid");
  }
  const [first, second] = fieldLengths;
  switch (kind) {
    case ExceptionKindCode.Boolean:
      if ((flags & ~FLAG_BOOLEAN_TRUE) !== 0 || first !== 0 || second !== 0) {
        throw new Error("malformed boolean Worker exception recipe");
      }
      return;
    case ExceptionKindCode.Symbol:
      if (
        (flags & ~(FLAG_SYMBOL_GLOBAL | FLAG_SYMBOL_HAS_DESCRIPTION)) !== 0
        || second !== 0
        || (
          (flags & FLAG_SYMBOL_GLOBAL) !== 0
          && (flags & FLAG_SYMBOL_HAS_DESCRIPTION) === 0
        )
      ) {
        throw new Error("malformed symbol Worker exception recipe");
      }
      return;
    case ExceptionKindCode.BigInt:
    case ExceptionKindCode.String:
      if (flags !== 0 || second !== 0) {
        throw new Error("malformed scalar Worker exception recipe");
      }
      return;
    case ExceptionKindCode.Error:
      if (flags !== 0) {
        throw new Error("malformed Error Worker exception recipe");
      }
      return;
    default:
      if (flags !== 0 || first !== 0 || second !== 0) {
        throw new Error("malformed opaque Worker exception recipe");
      }
  }
}

/**
 * Owner-side state for the exceptional, chunked normalization protocol.
 *
 * Sessions contain only scalar code units. They own no Worker object and are
 * cleared explicitly with the Worker binding on teardown.
 */
export class ForkWorkerExceptionCapabilityOwner {
  private readonly sessions = new Map<number, OwnerExceptionSession>();
  private nextSessionId = 1;
  private installed = false;

  install(catalog: ForkExternrefImportOwnerCatalog): void {
    if (this.installed) {
      throw new Error("Worker exception owner was installed twice");
    }
    this.installed = true;
    catalog.register(
      FORK_WORKER_EXCEPTION_BEGIN_DESCRIPTOR,
      (context, ...args) => this.begin(context, args),
    );
    catalog.register(
      FORK_WORKER_EXCEPTION_CHUNK_DESCRIPTOR,
      (context, ...args) => this.append(context, args),
    );
    catalog.register(
      FORK_WORKER_EXCEPTION_COMMIT_DESCRIPTOR,
      (context, sessionId) => this.commit(context, sessionId),
    );
    catalog.register(
      FORK_WORKER_EXCEPTION_ABORT_DESCRIPTOR,
      (context, sessionId) => {
        this.abort(context, sessionId);
      },
    );
  }

  clearBinding(binding: ForkExternrefImportBinding): void {
    for (const [sessionId, session] of this.sessions) {
      if (sameBinding(session.binding, binding)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Test/diagnostic visibility without exposing mutable session contents. */
  get activeSessionCount(): number {
    return this.sessions.size;
  }

  private begin(
    binding: ForkExternrefImportBinding,
    args: readonly unknown[],
  ): number {
    const version = assertI32(args[0], "Worker exception recipe version");
    if (version !== FORK_WORKER_EXCEPTION_RECIPE_VERSION) {
      throw new Error(`unsupported Worker exception recipe version ${version}`);
    }
    const sourceImportOrdinal = assertNonnegativeI32(
      args[1],
      "Worker exception source import ordinal",
    );
    const kind = assertI32(
      args[2],
      "Worker exception kind",
    ) as ExceptionKindCode;
    const flags = assertNonnegativeI32(
      args[3],
      "Worker exception flags",
    );
    const scalarBits = assertI64(args[4], "Worker exception scalar bits");
    const fieldLengths: [number, number] = [
      assertNonnegativeI32(args[5], "Worker exception field 0 length"),
      assertNonnegativeI32(args[6], "Worker exception field 1 length"),
    ];
    validateRecipeShape(kind, flags, fieldLengths);

    const sessionId = this.allocateSessionId();
    this.sessions.set(sessionId, {
      binding: {
        pid: binding.pid,
        generationId: binding.generationId,
        senderId: binding.senderId,
      },
      sourceImportOrdinal,
      kind,
      flags,
      scalarBits,
      expectedLengths: fieldLengths,
      chunks: [[], []],
      receivedLengths: [0, 0],
    });
    return sessionId;
  }

  private append(
    binding: ForkExternrefImportBinding,
    args: readonly unknown[],
  ): undefined {
    const sessionId = assertNonnegativeI32(
      args[0],
      "Worker exception session",
    );
    const field = assertNonnegativeI32(
      args[1],
      "Worker exception field",
    );
    const offset = assertNonnegativeI32(
      args[2],
      "Worker exception field offset",
    );
    if (field > 1) throw new RangeError(`invalid Worker exception field ${field}`);
    const session = this.requireSession(binding, sessionId);
    if (offset !== session.receivedLengths[field]) {
      throw new Error(
        `Worker exception field ${field} expected offset `
        + `${session.receivedLengths[field]}, received ${offset}`,
      );
    }
    const remaining = session.expectedLengths[field] - offset;
    if (remaining <= 0) {
      throw new Error(`Worker exception field ${field} is already complete`);
    }
    const count = Math.min(remaining, CHUNK_CODE_UNITS);
    const words = args.slice(3).map((value, index) =>
      assertI64(value, `Worker exception chunk word ${index}`)
    );
    if (words.length !== CHUNK_WORDS) {
      throw new Error("Worker exception chunk has the wrong word count");
    }
    session.chunks[field].push(unpackCodeUnits(words, count));
    session.receivedLengths[field] += count;
    return undefined;
  }

  private commit(
    binding: ForkExternrefImportBinding,
    rawSessionId: unknown,
  ): ForkWorkerExceptionCapability {
    const sessionId = assertNonnegativeI32(
      rawSessionId,
      "Worker exception session",
    );
    const session = this.requireSession(binding, sessionId);
    if (
      session.receivedLengths[0] !== session.expectedLengths[0]
      || session.receivedLengths[1] !== session.expectedLengths[1]
    ) {
      throw new Error("Worker exception recipe was committed before completion");
    }
    this.sessions.delete(sessionId);
    const fields: [string, string] = [
      session.chunks[0].join(""),
      session.chunks[1].join(""),
    ];
    return this.materializeCapability(session, fields);
  }

  private abort(
    binding: ForkExternrefImportBinding,
    rawSessionId: unknown,
  ): void {
    const sessionId = assertNonnegativeI32(
      rawSessionId,
      "Worker exception session",
    );
    this.requireSession(binding, sessionId);
    this.sessions.delete(sessionId);
  }

  private materializeCapability(
    session: OwnerExceptionSession,
    fields: readonly [string, string],
  ): ForkWorkerExceptionCapability {
    let boundaryValue: unknown;
    switch (session.kind) {
      case ExceptionKindCode.Undefined:
        boundaryValue = undefined;
        break;
      case ExceptionKindCode.Null:
        boundaryValue = null;
        break;
      case ExceptionKindCode.Boolean:
        boundaryValue = (session.flags & FLAG_BOOLEAN_TRUE) !== 0;
        break;
      case ExceptionKindCode.Number:
        boundaryValue = numberFromExactBits(session.scalarBits);
        break;
      case ExceptionKindCode.BigInt:
        boundaryValue = BigInt(fields[0]);
        break;
      case ExceptionKindCode.String:
        boundaryValue = fields[0];
        break;
      case ExceptionKindCode.Symbol:
        boundaryValue = (session.flags & FLAG_SYMBOL_GLOBAL) !== 0
          ? Symbol.for(fields[0])
          : (session.flags & FLAG_SYMBOL_HAS_DESCRIPTION) !== 0
          ? Symbol(fields[0])
          : Symbol();
        break;
      case ExceptionKindCode.Error:
      case ExceptionKindCode.Object:
      case ExceptionKindCode.Function:
        boundaryValue = undefined;
        break;
      default:
        kindName(session.kind);
    }
    return createForkWorkerExceptionCapability({
      sourceImportOrdinal: session.sourceImportOrdinal,
      kind: kindName(session.kind),
      name: session.kind === ExceptionKindCode.Error ? fields[0] : undefined,
      message: session.kind === ExceptionKindCode.Error
        ? fields[1]
        : undefined,
      boundaryValue,
    });
  }

  private requireSession(
    binding: ForkExternrefImportBinding,
    sessionId: number,
  ): OwnerExceptionSession {
    const session = this.sessions.get(sessionId);
    if (!session || !sameBinding(session.binding, binding)) {
      throw new Error(
        `unknown Worker exception session ${sessionId} for `
        + `pid=${binding.pid} generation=${binding.generationId} `
        + `sender=${binding.senderId}`,
      );
    }
    return session;
  }

  private allocateSessionId(): number {
    const start = this.nextSessionId;
    do {
      const candidate = this.nextSessionId++;
      if (this.nextSessionId > MAX_SESSION_ID) this.nextSessionId = 1;
      if (!this.sessions.has(candidate)) return candidate;
    } while (this.nextSessionId !== start);
    throw new RangeError("Worker exception normalization session space exhausted");
  }
}

function buildFatalTrap(): () => never {
  // (module (func (export "trap") unreachable))
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04, 0x74, 0x72, 0x61, 0x70, 0x00, 0x00,
    0x0a, 0x05, 0x01, 0x03, 0x00, 0x00, 0x0b,
  ]);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const trap = instance.exports.trap;
  if (typeof trap !== "function") {
    throw new Error("failed to construct Worker exception fatal trap");
  }
  return (): never => {
    trap();
    throw new Error("unreachable Worker exception fatal trap returned");
  };
}

const fatalTrap = buildFatalTrap();

/**
 * Whether to log the ORIGIN of a fatal fork trap on the error channel before it
 * is re-raised (see `replaceThrown`). Opt-in because the same boundary carries
 * the expected per-fork child-exit teardown trap. Reads
 * `WASM_POSIX_FORK_TRAP_DIAG=1` (Node) or `globalThis.__wpkForkTrapDiag` truthy
 * (browser); host-agnostic and safe when neither `process` nor the global
 * exists.
 */
function forkTrapDiagnosticsEnabled(): boolean {
  try {
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env;
    if (env && env.WASM_POSIX_FORK_TRAP_DIAG === "1") return true;
  } catch {
    // no `process` in this host
  }
  try {
    if ((globalThis as { __wpkForkTrapDiag?: unknown }).__wpkForkTrapDiag) {
      return true;
    }
  } catch {
    // no accessible global flag
  }
  return false;
}

export interface ForkWorkerLocalImportExceptionNormalizerOptions {
  readonly onFatal?: (
    error: unknown,
    sourceImportOrdinal: number,
  ) => void;
}

/**
 * Exception-only adapter for imports that must execute beside their Wasm
 * instance (memory, activation, syscall, and dynamic-linker intrinsics).
 *
 * Normal returns and ordinary throws perform no owner RPC, preserving exact
 * JavaScript/Wasm exception behavior. A nested Wasm RuntimeError is re-trapped
 * so it cannot become CatchAllRef-visible merely by crossing this JS frame.
 * Values that remain live at fork are normalized separately, after exact tag
 * codecs have had the opportunity to claim them.
 */
export class ForkWorkerLocalImportExceptionNormalizer {
  private readonly objectTokens =
    new WeakMap<object, ForkExternrefToken>();
  private readonly symbolTokens =
    new Map<symbol, ForkExternrefToken>();

  constructor(
    private readonly caller: ForkExternrefImportWorkerCaller,
    private readonly tokens: ForkExternrefTokenCache,
    private readonly options:
      ForkWorkerLocalImportExceptionNormalizerOptions = {},
  ) {}

  wrap<T extends CallableFunction>(
    sourceImportOrdinal: number,
    implementation: T,
  ): T {
    if (
      !Number.isInteger(sourceImportOrdinal)
      || sourceImportOrdinal < 0
      || sourceImportOrdinal > 0x7fff_ffff
    ) {
      throw new RangeError(
        `invalid Worker-local import ordinal ${sourceImportOrdinal}`,
      );
    }
    const normalizer = this;
    return function (
      this: unknown,
      ...args: unknown[]
    ): unknown {
      try {
        return Reflect.apply(implementation, this, args);
      } catch (thrown) {
        return normalizer.replaceThrown(
          sourceImportOrdinal,
          thrown,
        );
      }
    } as unknown as T;
  }

  clear(): void {
    this.symbolTokens.clear();
    // WeakMap keys do not keep Worker-local objects alive. The whole
    // normalizer becomes unreachable on exec/Worker teardown.
  }

  /**
   * Normalize a Worker-local value only when fork capture proves a fresh child
   * needs it. This is shared by raw externrefs and by exceptions that every
   * activation-local exact-tag codec has declined.
   *
   * Before that point the value remains exact, preserving ordinary host-import
   * and exception behavior in the parent.
   */
  normalizeUnclaimedForkValue(value: unknown): ForkExternrefToken {
    const existingHandle = this.tokens.encode(value);
    if (existingHandle !== null) return value as ForkExternrefToken;
    const cached = this.cachedToken(value);
    if (cached) return cached;
    try {
      const token = this.normalize(
        FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL,
        value,
      );
      this.rememberToken(value, token);
      return token;
    } catch (error) {
      try {
        this.options.onFatal?.(
          error,
          FORK_WORKER_EXCEPTION_FORK_CAPTURE_ORDINAL,
        );
      } catch {
        // Diagnostics cannot replace the capture failure.
      }
      throw error;
    }
  }

  normalizeUnclaimedForkException(thrown: unknown): ForkExternrefToken {
    return this.normalizeUnclaimedForkValue(thrown);
  }

  private replaceThrown(
    sourceImportOrdinal: number,
    thrown: unknown,
  ): never {
    if (thrown instanceof WebAssembly.RuntimeError) {
      // A nested Wasm call can surface a trap as a RuntimeError in this JS
      // frame. Re-entering Wasm by throwing that JS object would turn it into
      // a catchable JSTag exception, so preserve trap semantics explicitly.
      //
      // `fatalTrap()` below intentionally DISCARDS this RuntimeError's message
      // and stack to keep the trap uncatchable across the import boundary. That
      // masking is why a genuine co-resident fork-module trap (capture, decode,
      // or replay) previously surfaced only as a bare `unreachable` attributed
      // to the `__wpk_fork_unwind_transport_*` helper, hiding its true origin.
      // Surface the ORIGIN before re-raising: always via the diagnostic hook
      // when wired, and on the error channel when trap diagnostics are enabled.
      //
      // The error-channel log is OPT-IN because this same branch also carries
      // the EXPECTED child-exit teardown trap (`kernel_exit` -> `unreachable`),
      // which crosses this boundary on every successful fork; logging it
      // unconditionally would bury real faults in per-fork noise. Enable with
      // `WASM_POSIX_FORK_TRAP_DIAG=1` (Node) or `globalThis.__wpkForkTrapDiag`
      // (browser) when investigating a masked fork trap.
      try {
        this.options.onFatal?.(thrown, sourceImportOrdinal);
      } catch {
        // Diagnostics must never replace or suppress the fatal trap.
      }
      if (forkTrapDiagnosticsEnabled()) {
        try {
          // eslint-disable-next-line no-console
          console.error(
            `[fork] fatal trap crossing worker-local import ` +
              `ordinal=${sourceImportOrdinal}: ${thrown.message}\n${thrown.stack ?? ""}`,
          );
        } catch {
          // Never let logging change the trap path.
        }
      }
      return fatalTrap();
    }
    // WHY: eager normalization would change ordinary CatchAllRef/rethrow
    // behavior even when fork is never called. The broker normalizes only if
    // this exact value remains live at fork and no activation codec owns it.
    throw thrown;
  }

  private normalize(
    sourceImportOrdinal: number,
    thrown: unknown,
  ): ForkExternrefToken {
    const recipe = describeThrown(thrown);
    let sessionId: number | undefined;
    try {
      sessionId = this.caller.call(
        FORK_WORKER_EXCEPTION_BEGIN_DESCRIPTOR,
        [
          FORK_WORKER_EXCEPTION_RECIPE_VERSION,
          sourceImportOrdinal,
          recipe.kind,
          recipe.flags,
          recipe.scalarBits,
          recipe.fields[0].length,
          recipe.fields[1].length,
        ],
      ) as number;
      for (let field = 0; field < recipe.fields.length; field++) {
        const value = recipe.fields[field]!;
        for (let offset = 0; offset < value.length; offset += CHUNK_CODE_UNITS) {
          this.caller.call(
            FORK_WORKER_EXCEPTION_CHUNK_DESCRIPTOR,
            [
              sessionId,
              field,
              offset,
              ...packCodeUnits(value, offset),
            ] as ForkExternrefImportValue[],
          );
        }
      }
      const token = this.caller.call(
        FORK_WORKER_EXCEPTION_COMMIT_DESCRIPTOR,
        [sessionId],
      );
      const handle = this.tokens.encode(token);
      if (handle === null) {
        throw new Error(
          "Worker exception owner returned a noncanonical externref token",
        );
      }
      sessionId = undefined;
      return token as ForkExternrefToken;
    } catch (error) {
      if (sessionId !== undefined) {
        try {
          this.caller.call(
            FORK_WORKER_EXCEPTION_ABORT_DESCRIPTOR,
            [sessionId],
          );
        } catch {
          // Preserve the original normalization failure. Endpoint teardown
          // clears any scalar-only abandoned session.
        }
      }
      throw error;
    }
  }

  private cachedToken(thrown: unknown): ForkExternrefToken | undefined {
    if (
      (typeof thrown === "object" && thrown !== null)
      || typeof thrown === "function"
    ) {
      return this.objectTokens.get(thrown as object);
    }
    if (typeof thrown === "symbol") {
      return this.symbolTokens.get(thrown);
    }
    return undefined;
  }

  private rememberToken(
    thrown: unknown,
    token: ForkExternrefToken,
  ): void {
    if (
      (typeof thrown === "object" && thrown !== null)
      || typeof thrown === "function"
    ) {
      this.objectTokens.set(thrown as object, token);
    } else if (typeof thrown === "symbol") {
      this.symbolTokens.set(thrown, token);
    }
  }
}
