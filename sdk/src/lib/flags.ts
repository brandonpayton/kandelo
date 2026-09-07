import type { WasmArch } from './arch.ts';
import { targetTriple, toolPrefix } from './arch.ts';

export function compileFlags(arch: WasmArch): string[] {
  return [
    `--target=${targetTriple(arch)}`,
    // LLVM's generic wasm target has no operating-system identity, but
    // Kandelo is a Unix/POSIX userspace.  Publish that source-environment
    // contract through the reserved macros that Unix compilers conventionally
    // predefine.  This keeps upstream feature selection (including SDL's Unix
    // platform headers) truthful without claiming Linux or another host OS.
    '-D__unix__=1',
    '-D__unix=1',
    '-matomics',
    '-mbulk-memory',
    '-mexception-handling',
    '-mllvm', '-wasm-enable-sjlj',
    // Modern wasm-EH lowering. Empirical finding 2026-05-14: LLVM 21's
    // default for `-wasm-use-legacy-eh` is `true` — just dropping the
    // earlier `=true` override (commit 9 of the fork-instrument
    // mega-PR) leaves the toolchain on legacy `try`/`catch` lowering.
    // To actually get modern `try_table`/`catch_ref` we must pass
    // `=false` explicitly. Verified by inspecting the disassembly of
    // a C-02 build with this flag flipped.
    '-mllvm', '-wasm-use-legacy-eh=false',
    '-fno-trapping-math',
  ];
}

export const DEFAULT_MAIN_THREAD_STACK_SIZE = 8 * 1024 * 1024;
export const MAX_EXECUTABLE_MEMORY_SIZE = 1024 * 1024 * 1024;

type ParsedStackSize =
  | { kind: 'valid'; value: number }
  | { kind: 'invalid' }
  | { kind: 'overflow' };

function parseLldStackSize(value: string): ParsedStackSize {
  let digits: string;
  let radix: 2 | 8 | 10 | 16;

  // Match LLVM 21's radix-0 integer grammar exactly. Invalid spellings are
  // left for wasm-ld to reject so the compiler driver never rewrites input.
  if (/^0[xX][0-9a-fA-F]+$/.test(value)) {
    digits = value.slice(2);
    radix = 16;
  } else if (/^0[bB][01]+$/.test(value)) {
    digits = value.slice(2);
    radix = 2;
  } else if (/^0o[0-7]+$/.test(value)) {
    digits = value.slice(2);
    radix = 8;
  } else if (/^0[0-7]*$/.test(value)) {
    digits = value.slice(1) || '0';
    radix = 8;
  } else if (/^[1-9][0-9]*$/.test(value)) {
    digits = value;
    radix = 10;
  } else {
    return { kind: 'invalid' };
  }

  const significantDigits = digits.replace(/^0+/, '') || '0';
  const maxDigits = radix === 2 ? 31 : radix === 8 ? 11 : radix === 10 ? 10 : 8;
  if (significantDigits.length > maxDigits) return { kind: 'overflow' };

  const prefix = radix === 2 ? '0b' : radix === 8 ? '0o' : radix === 16 ? '0x' : '';
  const parsed = BigInt(`${prefix}${significantDigits}`);
  if (parsed > BigInt(MAX_EXECUTABLE_MEMORY_SIZE)) return { kind: 'overflow' };

  return { kind: 'valid', value: Number(parsed) };
}

export const MAX_RESPONSE_FILE_EXPANSIONS = 4096;
export const MAX_RESPONSE_FILE_TOKENS = 1024 * 1024;
export const MAX_RESPONSE_FILE_CHARACTERS = 64 * 1024 * 1024;

export interface ResponseFileContents {
  contents: string;
  /** Canonical identity used only while this file is active in the expansion stack. */
  identity: string;
}

export type ResponseFileReader = (path: string) => ResponseFileContents | null;

function isGnuResponseWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/** Match LLVM's POSIX TokenizeGNUCommandLine response-file grammar. */
export function tokenizeGnuResponseFile(source: string): string[] {
  if (source.startsWith('\uFEFF')) source = source.slice(1);

  const tokens: string[] = [];
  let token = '';

  for (let i = 0; i < source.length; i++) {
    if (token.length === 0) {
      while (i < source.length && isGnuResponseWhitespace(source[i])) i++;
      if (i === source.length) break;
    }

    const char = source[i];
    if (char === '\\' && i + 1 < source.length) {
      token += source[++i];
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) i++;
        token += source[i++];
      }
      if (i === source.length) break;
      continue;
    }

    if (isGnuResponseWhitespace(char)) {
      if (token.length > 0) tokens.push(token);
      token = '';
      continue;
    }

    token += char;
  }

  if (token.length > 0) tokens.push(token);
  return tokens;
}

export function expandResponseFiles(
  args: string[],
  readResponseFile: ResponseFileReader,
): string[] {
  const expanded: string[] = [];
  const activeFiles = new Set<string>();
  type WorkItem =
    | { kind: 'argument'; value: string }
    | { kind: 'leave'; identity: string };
  const work: WorkItem[] = [];
  for (let index = args.length - 1; index >= 0; index--) {
    work.push({ kind: 'argument', value: args[index] });
  }

  let fileExpansions = 0;
  let examinedTokens = args.length;
  let decodedCharacters = 0;
  if (examinedTokens > MAX_RESPONSE_FILE_TOKENS) {
    throw new Error(
      `response-file expansion exceeds the ${MAX_RESPONSE_FILE_TOKENS}-token safety limit`,
    );
  }

  while (work.length > 0) {
    const item = work.pop() as WorkItem;
    if (item.kind === 'leave') {
      activeFiles.delete(item.identity);
      continue;
    }

    const arg = item.value;
    if (!arg.startsWith('@') || arg.length === 1) {
      expanded.push(arg);
      continue;
    }
    const path = arg.slice(1);
    const responseFile = readResponseFile(path);
    if (responseFile === null) {
      throw new Error(`cannot inspect response file ${JSON.stringify(path)} before linking`);
    }
    if (responseFile.identity.length === 0) {
      throw new Error(`response file ${JSON.stringify(path)} has no canonical identity`);
    }
    if (activeFiles.has(responseFile.identity)) {
      throw new Error(`recursive response file ${JSON.stringify(path)} cannot be inspected safely`);
    }

    fileExpansions++;
    if (fileExpansions > MAX_RESPONSE_FILE_EXPANSIONS) {
      throw new Error(
        `response-file expansion exceeds the ${MAX_RESPONSE_FILE_EXPANSIONS}-file safety limit`,
      );
    }
    decodedCharacters += responseFile.contents.length;
    if (decodedCharacters > MAX_RESPONSE_FILE_CHARACTERS) {
      throw new Error(
        `response-file expansion exceeds the ${MAX_RESPONSE_FILE_CHARACTERS}-character safety limit`,
      );
    }

    const nestedTokens = tokenizeGnuResponseFile(responseFile.contents);
    examinedTokens += nestedTokens.length;
    if (examinedTokens > MAX_RESPONSE_FILE_TOKENS) {
      throw new Error(
        `response-file expansion exceeds the ${MAX_RESPONSE_FILE_TOKENS}-token safety limit`,
      );
    }

    activeFiles.add(responseFile.identity);
    work.push({ kind: 'leave', identity: responseFile.identity });
    for (let index = nestedTokens.length - 1; index >= 0; index--) {
      work.push({ kind: 'argument', value: nestedTokens[index] });
    }
  }

  return expanded;
}

/**
 * Apply the SDK's stack-size floor while retaining explicit larger requests.
 * Callers pass the exact argv emitted for wasm-ld by Clang's `-###` trace. That
 * keeps Clang's option classification and ordering in Clang itself instead of
 * duplicating its driver option table here.
 */
export function mainThreadStackSize(
  linkerArgs: string[],
  readResponseFile?: ResponseFileReader,
): number {
  let result = DEFAULT_MAIN_THREAD_STACK_SIZE;

  const consider = (value: string): void => {
    const requested = parseLldStackSize(value);
    if (requested.kind === 'overflow') {
      throw new Error(
        `stack-size=${value} exceeds the SDK's ${MAX_EXECUTABLE_MEMORY_SIZE}-byte executable memory limit`,
      );
    }
    if (requested.kind === 'valid' && requested.value > result) result = requested.value;
  };

  const lldArgs = readResponseFile
    ? expandResponseFiles(linkerArgs, readResponseFile)
    : linkerArgs;
  for (let i = 0; i < lldArgs.length; i++) {
    const arg = lldArgs[i];
    if (arg === '--') break;

    if (arg === '-z') {
      const value = lldArgs[++i];
      if (value?.startsWith('stack-size=')) {
        consider(value.slice('stack-size='.length));
      }
      continue;
    }

    if (arg.startsWith('-zstack-size=')) {
      consider(arg.slice('-zstack-size='.length));
    }
  }

  return result;
}

export function linkFlags(
  arch: WasmArch,
  mainThreadStackSizeBytes = DEFAULT_MAIN_THREAD_STACK_SIZE,
): string[] {
  return [
    '-nostdlib',
    // Reactor link mode leaves constructor ownership with musl. The host still
    // enters through the explicitly exported `_start` below.
    '-Wl,--no-entry',
    '-Wl,--export=_start',
    '-Wl,--export=__heap_base',
    '-Wl,--import-memory',
    '-Wl,--shared-memory',
    `-Wl,--max-memory=${MAX_EXECUTABLE_MEMORY_SIZE}`,
    '-Wl,--allow-undefined',
    // Reserve an 8 MiB main-thread shadow stack. wasm-ld's default is only
    // ~64 KiB, and WebAssembly has no stack guard page, so a deep call chain
    // silently overflows past __data_end into .bss and corrupts the pthread/TLS
    // globals that live there (__wasm_tp_storage, __pthread_tsd_main), which
    // then surfaces as a spurious "memory access out of bounds" far from the
    // real fault. POSIX leaves the default stack size implementation-defined,
    // but 8 MiB is the de-facto Linux/glibc RLIMIT_STACK default that mainstream
    // C software (GTK, etc.) is written and tested against, so matching it
    // maximizes portability. Treat it as a floor: callers retain explicit larger
    // requests. This sizes only the main thread; pthreads get their own stacks
    // from musl's __default_stacksize. Cost: at least ~8 MiB of initial linear
    // memory per process (it raises __heap_base 1:1). Keep in sync with the bash
    // wasm32posix-cc. See docs/sdk-guide.md.
    `-Wl,-z,stack-size=${mainThreadStackSizeBytes}`,
    '-Wl,--global-base=1114112',
    '-Wl,--table-base=3',
    '-Wl,--export-table',
    '-Wl,--growable-table',
    '-Wl,--export=__wasm_init_tls',
    '-Wl,--export=__tls_base',
    '-Wl,--export=__tls_size',
    '-Wl,--export=__tls_align',
    '-Wl,--export=__stack_pointer',
    '-Wl,--export=__wasm_thread_init',
    // Pinned so later build stages do not drop the runtime ABI marker the host
    // verifies against. See docs/abi-versioning.md.
    '-Wl,--export=__abi_version',
  ];
}

/** @deprecated Use compileFlags('wasm32') */
export const COMPILE_FLAGS: string[] = compileFlags('wasm32');
/** @deprecated Use linkFlags('wasm32') */
export const LINK_FLAGS: string[] = linkFlags('wasm32');

/** Link flags for building shared Wasm libraries (.so side modules). */
export const SHARED_LINK_FLAGS: string[] = [
  '-nostdlib',
  '-Wl,--experimental-pic',
  '-Wl,--shared',
  '-Wl,--shared-memory',
  '-Wl,--export-all',
  '-Wl,--allow-undefined',
];

const IGNORED_EXACT = new Set([
  '-lpthread',
  '-fPIE', '-pie',
  '-lrt', '-lresolv', '-lm', '-lcrypt', '-lutil',
  // -lgcc_s: WebAssembly has no shared libgcc; unwinder/intrinsic symbols
  // come from the compiler runtime (compiler_builtins for Rust,
  // compiler_rt glue for C), so a -lgcc_s request (e.g. from rustc's link
  // line when it drives the SDK as its linker) must be dropped rather than
  // passed to wasm-ld, which would fail to find it. A bare -lc is NOT
  // ignored here: the SDK deliberately preserves and orders explicit -lc
  // after the syscall glue (it resolves to the sysroot musl libc.a).
  '-lgcc_s',
  '-rdynamic', '-Wl,-Bsymbolic',
  '-Wl,-z,noexecstack', '-Wl,-z,text', '-Wl,-z,relro',
  '-Wl,-z,now', '-Wl,-z,nocopyreloc',
]);

const IGNORED_PREFIXES = [
  '-Wl,-rpath,',
  '-Wl,-rpath-link,',
  '-Wl,-soname,',
  '-Wl,--version-script',
];

const WARN_FLAGS = new Set([
  '-dynamiclib',
]);

function isEquivalentWasmTarget(value: string, arch: WasmArch): boolean {
  return value === targetTriple(arch) ||
    value === `${arch}-unknown-linux-musl` ||
    value === `${arch}-linux-musl`;
}

export interface FilterResult {
  filtered: string[];
  warnings: string[];
}

export function filterArgs(args: string[], arch: WasmArch = 'wasm32'): FilterResult {
  const filtered: string[] = [];
  const warnings: string[] = [];
  const prefix = toolPrefix(arch);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--target=') && isEquivalentWasmTarget(arg.slice('--target='.length), arch)) {
      continue;
    }
    if ((arg === '--target' || arg === '-target') && i + 1 < args.length && isEquivalentWasmTarget(args[i + 1], arch)) {
      i++;
      continue;
    }
    if (IGNORED_EXACT.has(arg)) continue;
    if (IGNORED_PREFIXES.some(p => arg.startsWith(p))) continue;
    if (WARN_FLAGS.has(arg)) {
      warnings.push(`${prefix}-cc: warning: ${arg} is not supported for Wasm targets (ignored)`);
      continue;
    }
    filtered.push(arg);
  }

  return { filtered, warnings };
}

export interface ParsedArgs {
  compileOnly: boolean;
  preprocessOnly: boolean;
  assemblyOnly: boolean;
  shared: boolean;
  pic: boolean;
  linkDl: boolean;
  threadSlots: number | null;
  outputFile: string | null;
  sourceFiles: string[];
  objectFiles: string[];
  archiveFiles: string[];
  otherArgs: string[];
  /** Arguments forwarded to clang, in the exact order supplied by the caller. */
  forwardedArgs: string[];
}

const SOURCE_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm', '.i', '.ii']);
const OBJECT_EXTS = new Set(['.o', '.obj']);
const ARCHIVE_EXTS = new Set(['.a']);

// Flags that consume the next argument as a value (not a file path).
const FLAGS_WITH_VALUE = new Set([
  '-MT', '-MF', '-MQ', '-MJ',
  '-isystem', '-include', '-imacros',
  '-idirafter', '-iprefix', '-iwithprefix', '-iwithprefixbefore',
  '-isysroot',
  '-target', '-arch',
  '-x',
  '-D', '-U', '-I', '-L', '-F',
]);

export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    compileOnly: false,
    preprocessOnly: false,
    assemblyOnly: false,
    shared: false,
    pic: false,
    linkDl: false,
    threadSlots: null,
    outputFile: null,
    sourceFiles: [],
    objectFiles: [],
    archiveFiles: [],
    otherArgs: [],
    forwardedArgs: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') {
      result.compileOnly = true;
    } else if (arg === '-shared') {
      result.shared = true;
    } else if (arg === '-fPIC') {
      result.pic = true;
    } else if (arg === '-ldl') {
      result.linkDl = true;
    } else if (arg === '--kandelo-thread-slots' || arg === '--wasm-posix-thread-slots') {
      i++;
      result.threadSlots = parseThreadSlotDeclaration(args[i], arg);
    } else if (arg.startsWith('--kandelo-thread-slots=')) {
      result.threadSlots = parseThreadSlotDeclaration(
        arg.substring('--kandelo-thread-slots='.length),
        '--kandelo-thread-slots',
      );
    } else if (arg.startsWith('--wasm-posix-thread-slots=')) {
      result.threadSlots = parseThreadSlotDeclaration(
        arg.substring('--wasm-posix-thread-slots='.length),
        '--wasm-posix-thread-slots',
      );
    } else if (arg === '-E') {
      result.preprocessOnly = true;
    } else if (arg === '-S') {
      result.assemblyOnly = true;
    } else if (arg === '-o') {
      i++;
      result.outputFile = args[i] ?? null;
    } else if (arg.startsWith('-o') && arg.length > 2) {
      result.outputFile = arg.substring(2);
    } else if (FLAGS_WITH_VALUE.has(arg)) {
      // Flag that takes the next arg as its value — keep both as otherArgs
      result.otherArgs.push(arg);
      result.forwardedArgs.push(arg);
      i++;
      if (i < args.length) {
        result.otherArgs.push(args[i]);
        result.forwardedArgs.push(args[i]);
      }
    } else if (!arg.startsWith('-')) {
      const ext = arg.substring(arg.lastIndexOf('.'));
      if (SOURCE_EXTS.has(ext)) {
        result.sourceFiles.push(arg);
      } else if (OBJECT_EXTS.has(ext)) {
        result.objectFiles.push(arg);
      } else if (ARCHIVE_EXTS.has(ext)) {
        result.archiveFiles.push(arg);
      } else {
        result.otherArgs.push(arg);
      }
      result.forwardedArgs.push(arg);
    } else {
      result.otherArgs.push(arg);
      result.forwardedArgs.push(arg);
    }
  }

  return result;
}

export function needsLinking(parsed: ParsedArgs): boolean {
  if (parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly) return false;
  if (parsed.otherArgs.some(arg => arg.startsWith('-Wl,@') || arg.startsWith('@'))) return true;
  return parsed.sourceFiles.length > 0 || parsed.objectFiles.length > 0;
}

export const THREAD_SLOT_USE_HOST_DEFAULT = -1;
export const THREAD_SLOT_NONE = 0;

export function threadSlotDeclarationDefine(value: number): string {
  return `-DWASM_POSIX_THREAD_SLOT_DECL=${value}`;
}

export function parseThreadSlotDeclaration(value: string | undefined, flag: string): number {
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires -1, 0, or a positive integer`);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flag} must be -1, 0, or a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < THREAD_SLOT_USE_HOST_DEFAULT) {
    throw new Error(`${flag} must be -1, 0, or a positive integer`);
  }
  return parsed;
}

export interface ThreadSlotInferenceOptions {
  readFile?: (path: string) => string | null;
}

const THREAD_OR_DYNAMIC_PATTERNS = [
  /pthread_create/,
  /thrd_create/,
  /\bclone\s*\(/,
  /std::thread/,
  /#include\s*<thread>/,
  /\bdlopen\b/,
  /__wasm_dlopen/,
];

function rawArgsSuggestThreadsOrDynamicLinking(args: string[]): boolean {
  return args.some((arg) =>
    arg === '-pthread' ||
    arg === '-lpthread' ||
    arg === '-ldl' ||
    arg === '-shared' ||
    arg === '-dynamiclib' ||
    arg === '-rdynamic' ||
    arg.startsWith('-Wl,-rpath') ||
    arg.startsWith('-Wl,-soname') ||
    arg.startsWith('-Wl,--export-dynamic')
  );
}

function hasUncertainLinkInput(parsed: ParsedArgs): boolean {
  if (parsed.objectFiles.length > 0 || parsed.archiveFiles.length > 0) return true;
  return parsed.otherArgs.some((arg) =>
    arg === '-fuse-ld=lld' ||
    arg.startsWith('-l') ||
    arg.startsWith('-Wl,') ||
    arg.startsWith('@')
  );
}

export function inferThreadSlotDeclaration(
  parsed: ParsedArgs,
  rawArgs: string[],
  options: ThreadSlotInferenceOptions = {},
): number {
  if (parsed.threadSlots !== null) return parsed.threadSlots;
  if (parsed.shared || parsed.linkDl) return THREAD_SLOT_USE_HOST_DEFAULT;
  if (rawArgsSuggestThreadsOrDynamicLinking(rawArgs)) return THREAD_SLOT_USE_HOST_DEFAULT;
  if (hasUncertainLinkInput(parsed)) return THREAD_SLOT_USE_HOST_DEFAULT;
  if (parsed.sourceFiles.length === 0) return THREAD_SLOT_USE_HOST_DEFAULT;

  for (const sourceFile of parsed.sourceFiles) {
    const text = options.readFile?.(sourceFile);
    if (text === null || text === undefined) return THREAD_SLOT_USE_HOST_DEFAULT;
    if (THREAD_OR_DYNAMIC_PATTERNS.some((pattern) => pattern.test(text))) {
      return THREAD_SLOT_USE_HOST_DEFAULT;
    }
  }

  return THREAD_SLOT_NONE;
}
