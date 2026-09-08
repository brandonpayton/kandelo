/**
 * Build-time opcache prewarmer for PHP VFS images.
 *
 * Boots a `NodeKernelHost` against the half-built VFS image, runs PHP CLI
 * with `opcache.file_cache_only=1` pointed at `/var/cache/opcache`, asks
 * it to `opcache_compile_file()` every `.php` under the configured source
 * roots, then dumps the resulting cache files back over stdout. Each
 * dumped file is written into the build's MemoryFileSystem at the same
 * VFS path the kernel saw, so when the demo boots its FPM workers pick
 * up the cache without paying the first-request compile cost.
 *
 * Compilation starts in one PHP CLI process and adaptively splits into
 * smaller fresh processes if application-level duplicate declarations
 * make a group un-compilable. A final "dump" spawn walks the cache
 * directory and base64-encodes each .bin back over stdout for the host
 * to ingest.
 *
 * Why the stdout round-trip:
 *   The kernel boots from a *snapshot* of the build's memfs — anything
 *   PHP writes lands in the kernel's private copy, not the build's. We
 *   either snapshot the kernel's memfs back out (no API for that today)
 *   or stream the new files over a channel we already have. stdout is
 *   that channel. The protocol is base64-line-framed so the host can
 *   parse the stream as simple newline-delimited text:
 *     ===OCDUMP_BEGIN===\n
 *     <count>\n
 *     <base64(path)>\n
 *     <base64(content)>\n  ×count
 *     ===OCDUMP_END===\n
 *   ~33% overhead, irrelevant at build time, and fully binary-safe.
 *
 * Set `KANDELO_NO_OPCACHE_PREWARM=1` to skip. By default, failures are
 * reported but do not fail the image build; set
 * `KANDELO_OPCACHE_PREWARM_STRICT=1` to make them fatal.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import { findRepoRoot, resolveBinary } from "../../../host/src/binary-resolver";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { writeVfsBinary, ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

export interface OpcachePrewarmOptions {
  /** Absolute VFS paths to walk for `.php` files. */
  sourceRoots: string[];
  /** Label used in log lines. */
  label: string;
  /** Absolute VFS paths that must not be compiled into the file cache. */
  excludePaths?: string[];
  /** Exact staged build inputs. Omit only for the legacy interactive path. */
  programs?: {
    php: Uint8Array;
    kernel: Uint8Array;
  };
}

// Must match the `opcache.file_cache=` setting in each demo's runtime
// php.ini — runtime FPM reads cache files from the same VFS path the
// prewarm dump wrote them to.
const CACHE_DIR = "/var/cache/opcache";

const DUMP_BEGIN = "===OCDUMP_BEGIN===\n";
const LIST_BEGIN = "===PHPLIST_BEGIN===\n";
const LIST_END = "===PHPLIST_END===\n";

const PHP_INI_ARGS = [
  "-d", "extension_dir=/usr/lib/php/extensions",
  "-d", "zend_extension=opcache",
  "-d", "opcache.enable=1",
  "-d", "opcache.enable_cli=1",
  "-d", "opcache.file_cache_only=1",
  "-d", `opcache.file_cache=${CACHE_DIR}`,
  // file_update_protection defaults to 2s; opcache refuses to cache
  // any file whose mtime is within that window. Every PHP file we
  // walk was just written into the in-memory VFS by this build, so
  // their mtimes are all "now" — we'd cache nothing without this.
  "-d", "opcache.file_update_protection=0",
  "-d", "memory_limit=512M",
];

const PHP_ENV = ["HOME=/tmp", "TMPDIR=/tmp"];

/**
 * Pre-populate the opcache file cache inside `fs` by compiling every
 * `.php` under `options.sourceRoots`. Mutates `fs` in place. Returns the
 * number of cache files written. A return of `0` is a soft failure —
 * the build still works, opcache just runs cold on first request.
 */
export async function prewarmOpcache(
  fs: MemoryFileSystem,
  options: OpcachePrewarmOptions,
): Promise<number> {
  ensureDirRecursive(fs, CACHE_DIR);

  if (process.env.KANDELO_NO_OPCACHE_PREWARM === "1") {
    console.log("[opcache-prewarm] skipped (KANDELO_NO_OPCACHE_PREWARM=1)");
    return 0;
  }

  const { label } = options;

  try {
    console.log(`[opcache-prewarm:${label}] booting kernel against in-memory VFS...`);
    const imageBytes = await fs.saveImage();

    // SpawnOptions has no per-call onStdout, so a single host-level
    // callback delegates to whichever phase is currently running.
    let activeStdoutSink: ((data: Uint8Array) => void) | null = null;
    const host = new NodeKernelHost({
      rootfsImage: imageBytes,
      // PHP-FPM forks, so this build-time boot exercises the co-resident fork
      // module — the unconditional fork reconstructor the kernel worker ships
      // to every process worker. Inject the staged artifact explicitly (like
      // the kernel above): this boot runs under the source-only resolution
      // policy with no source-only binary root, so the kernel worker resolving
      // the fork module through the binary resolver would fail.
      forkModuleBytesByWidth: { 4: loadStagedForkModule32() },
      onStdout: (_pid, data) => {
        activeStdoutSink?.(new Uint8Array(data));
      },
      onStderr: (_pid, data) => {
        process.stderr.write(data);
      },
    });

    let dumpBytes: Uint8Array;
    try {
      await host.init(options.programs === undefined
        ? undefined
        : exactProgramBuffer(options.programs.kernel, "opcache kernel"));
      const programBytes = options.programs === undefined
        ? exactProgramBuffer(
          new Uint8Array(readFileSync(resolveBinary("programs/php/php.wasm"))),
          "legacy opcache PHP",
        )
        : exactProgramBuffer(options.programs.php, "opcache PHP");

      const runPhase = async (phase: string, job: PhpJob): Promise<Uint8Array> => {
        const chunks: Uint8Array[] = [];
        activeStdoutSink = (data) => chunks.push(data);
        try {
          const stdin = buildJobStdin(job);
          const exitCode = await host.spawn(
            programBytes,
            ["php", ...PHP_INI_ARGS, "-r", buildJobScript(job)],
            { env: PHP_ENV, stdin },
          );
          if (exitCode !== 0) {
            const stdoutText = new TextDecoder("utf-8", { fatal: false }).decode(
              concatChunks(chunks),
            );
            const stdoutTail = stdoutText.slice(-4096);
            throw new Error(
              `[opcache-prewarm:${label}] ${phase} php exited with code ${exitCode}` +
              (stdoutTail ? `\n--- php stdout tail ---\n${stdoutTail}` : ""),
            );
          }
        } finally {
          activeStdoutSink = null;
        }
        return concatChunks(chunks);
      };

      // Phase 1: list every .php under the roots so the host can batch.
      console.log(`[opcache-prewarm:${label}] listing .php files...`);
      const listBytes = await runPhase("list", { kind: "list", roots: options.sourceRoots });
      const excluded = new Set(options.excludePaths ?? []);
      const listedPhpPaths = parseList(listBytes);
      const phpPaths = listedPhpPaths.filter((path) => !excluded.has(path));
      if (excluded.size > 0) {
        console.log(
          `[opcache-prewarm:${label}] excluded ${listedPhpPaths.length - phpPaths.length} php files from compile`,
        );
      }
      console.log(`[opcache-prewarm:${label}] ${phpPaths.length} php files to compile`);

      // Phase 2: compile every listed PHP file into the shared kernel memfs
      // cache dir. Some applications contain mutually exclusive fallback
      // files that redeclare the same functions/classes; if a batch trips
      // over one of those pairs, split it and continue in fresh PHP
      // processes so each side can still populate the shared file cache.
      console.log(`[opcache-prewarm:${label}] compiling ${phpPaths.length} files...`);
      await compileFiles(label, phpPaths, runPhase);

      // Phase 3: dump the populated /var/cache/opcache back over stdout.
      console.log(`[opcache-prewarm:${label}] dumping cache files...`);
      dumpBytes = await runPhase("dump", { kind: "dump" });
    } finally {
      await host.destroy().catch(() => {});
    }

    const written = ingestDump(dumpBytes, fs);
    console.log(`[opcache-prewarm:${label}] wrote ${written} cache files into ${CACHE_DIR}`);
    return written;
  } catch (err) {
    if (process.env.KANDELO_OPCACHE_PREWARM_STRICT === "1") {
      throw err;
    }
    console.warn(
      `[opcache-prewarm:${label}] skipped after failure: ${summarizeError(err)}`,
    );
    return 0;
  }
}

/**
 * Read the wasm32 co-resident fork module from its repo-staged location. The
 * fork module is built out-of-band by `crates/fork-module/build-wasm.sh` (the
 * local-build engine runs it before any package build) and staged into both
 * `local-binaries/` and `host/wasm/`; it is not a registry package, so there is
 * no `WASM_POSIX_DEP_*_DIR` for it. Loading the staged artifact directly keeps
 * this build-time boot independent of the source-only program projection, which
 * is not finalized mid-build.
 */
function loadStagedForkModule32(): Uint8Array {
  const repoRoot = findRepoRoot();
  const staged = join(repoRoot, "host/wasm/fork_module32.wasm");
  return new Uint8Array(readFileSync(staged));
}

function exactProgramBuffer(bytes: Uint8Array, label: string): ArrayBuffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error(`${label} input is empty`);
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

type PhpJob =
  | { kind: "list"; roots: string[] }
  | { kind: "compile"; files: string[] }
  | { kind: "dump" };

type RunPhpPhase = (phase: string, job: PhpJob) => Promise<Uint8Array>;

async function compileFiles(
  label: string,
  files: string[],
  runPhase: RunPhpPhase,
): Promise<void> {
  if (files.length === 0) return;
  try {
    await runPhase(`compile (${files.length} files)`, { kind: "compile", files });
    return;
  } catch (err) {
    if (files.length === 1) throw err;

    const mid = Math.ceil(files.length / 2);
    console.warn(
      `[opcache-prewarm:${label}] compile batch of ${files.length} failed; ` +
      `splitting into ${mid} + ${files.length - mid} (${summarizeError(err)})`,
    );
    await compileFiles(label, files.slice(0, mid), runPhase);
    await compileFiles(label, files.slice(mid), runPhase);
  }
}

function summarizeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const phpLine = text
    .split("\n")
    .find((line) => /(?:Fatal error|Parse error|WebAssembly\.Exception|exited with code)/.test(line));
  return (phpLine ?? text.split("\n")[0] ?? "unknown error").trim();
}

function buildJobScript(job: PhpJob): string {
  // Each job script:
  //   - list:    walk roots, emit ===PHPLIST_BEGIN===\n<path>\n…<path>\n===PHPLIST_END===
  //   - compile: opcache_compile_file() each base64 path read from stdin
  //   - dump:    walk cacheDir, emit ===OCDUMP_BEGIN=== framing
  // STDERR carries human-readable progress; STDOUT is the structured channel.
  if (job.kind === "list") {
    return `
$roots = json_decode(${JSON.stringify(JSON.stringify(job.roots))}, true);
echo "===PHPLIST_BEGIN===\\n";
$count = 0;
foreach ($roots as $root) {
    if (!is_dir($root)) { fwrite(STDERR, "[prewarm] skip missing root $root\\n"); continue; }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($it as $f) {
        if (!$f->isFile()) continue;
        if (strtolower($f->getExtension()) !== 'php') continue;
        echo base64_encode($f->getPathname()) . "\\n";
        $count++;
    }
}
echo "===PHPLIST_END===\\n";
fwrite(STDERR, "[prewarm] listed $count php files\\n");
`.trim();
  }

  if (job.kind === "compile") {
    return `
if (!extension_loaded('Zend OPcache')) {
    fwrite(STDERR, "[prewarm] FATAL: opcache extension not loaded\\n");
    exit(1);
}
$compiled = 0; $failed = 0;
$input = stream_get_contents(STDIN);
$files = preg_split('/\\r?\\n/', $input, -1, PREG_SPLIT_NO_EMPTY);
foreach ($files as $encodedPath) {
    $path = base64_decode($encodedPath, true);
    if ($path === false) { $failed++; continue; }
    $ok = @opcache_compile_file($path);
    if ($ok) { $compiled++; } else { $failed++; }
}
fwrite(STDERR, "[prewarm] compiled=$compiled failed=$failed\\n");
`.trim();
  }

  // dump
  return `
$cacheDir = ${JSON.stringify(CACHE_DIR)};
$entries = [];
if (is_dir($cacheDir)) {
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($cacheDir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($it as $f) {
        if ($f->isFile()) { $entries[] = $f->getPathname(); }
    }
}
// base64-encoded line records keep the host-side parser simple while
// preserving arbitrary cache-file bytes.
echo "===OCDUMP_BEGIN===\\n";
echo count($entries) . "\\n";
$bytes = 0;
foreach ($entries as $path) {
    $contents = @file_get_contents($path);
    if ($contents === false) {
        fwrite(STDERR, "[prewarm] read failed: $path\\n");
        $contents = '';
    }
    echo base64_encode($path) . "\\n";
    echo base64_encode($contents) . "\\n";
    $bytes += strlen($contents);
}
echo "===OCDUMP_END===\\n";
fwrite(STDERR, "[prewarm] dumped " . count($entries) . " cache files, $bytes bytes\\n");
`.trim();
}

function buildJobStdin(job: PhpJob): Uint8Array | undefined {
  if (job.kind !== "compile") return undefined;
  const body = job.files
    .map((path) => Buffer.from(new TextEncoder().encode(path)).toString("base64"))
    .join("\n");
  return new TextEncoder().encode(`${body}\n`);
}

function parseList(buf: Uint8Array): string[] {
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(LIST_BEGIN);
  if (beginAt < 0) {
    throw new Error("[opcache-prewarm] PHPLIST_BEGIN marker not found");
  }
  const body = text.substring(beginAt + LIST_BEGIN.length);
  const endAt = body.indexOf(LIST_END);
  if (endAt < 0) {
    throw new Error("[opcache-prewarm] PHPLIST_END marker not found");
  }
  return body
    .substring(0, endAt)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((b64) => new TextDecoder().decode(base64DecodeToBytes(b64)));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function ingestDump(buf: Uint8Array, fs: MemoryFileSystem): number {
  // Decode the entire buffer as UTF-8 (it's now all base64 + ASCII
  // framing). Locate the begin marker line, then read line-pairs:
  //   <count>\n
  //   <base64-path>\n
  //   <base64-content>\n
  //   ... ×count ...
  //   ===OCDUMP_END===\n
  // Anything before the begin marker is stderr leakage or PHP-warning
  // noise and is ignored.
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(DUMP_BEGIN);
  if (beginAt < 0) {
    throw new Error("[opcache-prewarm] OCDUMP_BEGIN marker not found in stdout");
  }
  const body = text.substring(beginAt + DUMP_BEGIN.length);
  const lines = body.split("\n");

  const recordCount = Number.parseInt(lines[0] ?? "", 10);
  if (!Number.isFinite(recordCount)) {
    throw new Error(`[opcache-prewarm] bad record count: ${JSON.stringify(lines[0])}`);
  }

  let cursor = 1;
  let written = 0;
  for (let i = 0; i < recordCount; i++) {
    const pathB64 = lines[cursor++];
    const contentB64 = lines[cursor++];
    if (pathB64 == null || contentB64 == null) {
      throw new Error(`[opcache-prewarm] truncated record ${i}/${recordCount}`);
    }
    const path = new TextDecoder().decode(base64DecodeToBytes(pathB64));
    const content = base64DecodeToBytes(contentB64);
    ensureDirRecursive(fs, dirname(path));
    writeVfsBinary(fs, path, content, 0o644);
    written++;
  }

  const trailer = lines[cursor];
  if (trailer !== "===OCDUMP_END===") {
    throw new Error(
      `[opcache-prewarm] missing OCDUMP_END trailer (got: ${JSON.stringify(trailer)})`,
    );
  }
  return written;
}

function base64DecodeToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
