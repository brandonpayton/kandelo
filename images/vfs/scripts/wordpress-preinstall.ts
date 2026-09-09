/**
 * Build-time WordPress installer for the browser demo VFS images.
 *
 * The builder's MemoryFileSystem is only a source snapshot for a temporary
 * NodeKernelHost boot, so mutations made by PHP/MariaDB inside that kernel
 * must be streamed back to the builder. This mirrors opcache-prewarm's stdout
 * dump protocol, but preserves directory/file ownership and modes for DB data.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeKernelHost, type NodeKernelHostOptions } from "../../../host/src/node-kernel-host";
import { findRepoRoot, resolveBinary } from "../../../host/src/binary-resolver";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { saveShellDerivedBuildGuestSnapshot } from "./package-shell-vfs-build";

export const WORDPRESS_DEFAULT_SITE_TITLE = "WordPress on Kandelo";
export const WORDPRESS_DEFAULT_ADMIN_USER = "admin";
export const WORDPRESS_DEFAULT_ADMIN_PASSWORD = "password";
export const WORDPRESS_DEFAULT_ADMIN_EMAIL = "admin@example.com";

const PHP_FPM_UID = 65534;
const PHP_FPM_GID = 65534;
const MYSQL_UID = 101;
const MYSQL_GID = 101;
const MARIADB_SOCKET_PATH = "/tmp/mysql.sock";
const MARIADB_PREINSTALL_SOCKET_PATH = "/data/mysql.sock";
const MARIADB_ARIA_LOG_FILE_SIZE = 16 * 1024 * 1024;
const MARIADB_ARIA_PAGECACHE_SIZE = 1024 * 1024;
const MARIADB_INNODB_LOG_FILE_SIZE = 16 * 1024 * 1024;
const MARIADB_INNODB_LOG_BUFFER_SIZE = 1024 * 1024;
const MARIADB_INNODB_BUFFER_POOL_SIZE = 8 * 1024 * 1024;

const BASE_ENV = [
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
];

const PHP_ARGS = [
  "php",
  "-c", "/etc/php.ini",
  "-d", "opcache.enable_cli=0",
  "-d", "memory_limit=512M",
  "-d", `mysqli.default_socket=${MARIADB_PREINSTALL_SOCKET_PATH}`,
  "-d", `pdo_mysql.default_socket=${MARIADB_PREINSTALL_SOCKET_PATH}`,
  "-r",
];

const DUMP_BEGIN = "===WPDB_DUMP_BEGIN===\n";
const DUMP_END = "===WPDB_DUMP_END===";

interface KernelSession {
  host: NodeKernelHost;
  hostDataDir?: string;
  runPhp: (phase: string, script: string, opts?: RunPhpOptions) => Promise<Uint8Array>;
  runPhpToHostFile: (
    phase: string,
    script: string,
    fileName: string,
    opts?: RunPhpOptions,
  ) => Promise<Uint8Array>;
  runProgram: (
    phase: string,
    bytes: ArrayBuffer,
    argv: string[],
    opts?: RunProgramOptions,
  ) => Promise<number>;
}

interface RunPhpOptions {
  cwd?: string;
  uid?: number;
  gid?: number;
  timeoutMs?: number;
}

interface RunProgramOptions {
  cwd?: string;
  timeoutMs?: number;
}

interface DumpRecord {
  type: "dir" | "file";
  path: string;
  mode: number;
  uid: number;
  gid: number;
  content?: Uint8Array;
}

interface PreinstallKernelHostOptions extends NodeKernelHostOptions {
  mountDataDir?: boolean;
  hostDataDir?: string;
  programs?: WordPressPreinstallPrograms;
}

export interface WordPressPreinstallPrograms {
  kernel: Uint8Array;
  php: Uint8Array;
  mariadb?: Uint8Array;
}

export async function preinstallWordPressSqlite(
  fs: MemoryFileSystem,
  programs?: WordPressPreinstallPrograms,
): Promise<void> {
  console.log("[wp-preinstall:sqlite] installing WordPress into SQLite database...");
  await withKernelSession(fs, async (session) => {
    await session.runPhp("install", wordpressInstallScript(), {
      cwd: "/var/www/html",
      uid: PHP_FPM_UID,
      gid: PHP_FPM_GID,
      timeoutMs: 120_000,
    });
    const dump = await session.runPhp("dump sqlite database", dumpScript([
      "/var/www/html/wp-content/database",
    ]), {
      cwd: "/var/www/html",
      timeoutMs: 120_000,
    });
    const written = ingestDump(dump, fs);
    assertVfsPath(fs, "/var/www/html/wp-content/database/wordpress.db");
    console.log(`[wp-preinstall:sqlite] wrote ${written} database entries`);
  }, { programs });
}

export async function preinstallWordPressMariaDb(
  fs: MemoryFileSystem,
  programs?: WordPressPreinstallPrograms,
): Promise<void> {
  console.log("[wp-preinstall:mariadb] initializing MariaDB /data and installing WordPress...");
  const hostDataDir = mkdtempSync(join(tmpdir(), "wp-preinstall-data-"));
  try {
    const mariadbBytes = programs?.mariadb === undefined
      ? loadProgram("programs/mariadb/mariadbd.wasm")
      : exactProgramBuffer(programs.mariadb, "WordPress MariaDB");
    prepareHostMariaDbDataDir(hostDataDir);
    await withKernelSession(fs, async (session) => {
      await bootstrapMariaDbSystemTables(session, fs, mariadbBytes);
    }, {
      maxWorkers: 16,
      dataBufferSize: 256 * 1024,
      mountDataDir: true,
      hostDataDir,
      programs,
    });
    makeHostMariaDbDataWritable(hostDataDir);

    await withKernelSession(fs, async (session) => {
      if (!session.hostDataDir) {
        throw new Error("MariaDB preinstall requires a host-mounted /data directory");
      }
      let mariadbPid = 0;
      let resolveStarted!: (pid: number) => void;
      const started = new Promise<number>((resolve) => { resolveStarted = resolve; });
      const serverExit = session.host.spawn(
        mariadbBytes,
        ["mariadbd", ...mariadbServerArgs()],
        {
          env: BASE_ENV,
          cwd: "/data",
          onStarted: (pid) => {
            mariadbPid = pid;
            resolveStarted(pid);
          },
        },
      );
      serverExit.catch(() => {});
      await withTimeout(started, 10_000, "mariadbd did not start");

      try {
        await Promise.race([
          waitForHostPath(join(session.hostDataDir, "mysql.sock"), 180_000),
          serverExit.then((code) => {
            throw new Error(`mariadbd exited before readiness check completed with code ${code}`);
          }),
        ]);
        await session.runPhp("install", wordpressInstallScript(), {
          cwd: "/var/www/html",
          timeoutMs: 240_000,
        });
        await session.runPhp("shutdown MariaDB", shutdownMariaDbScript(), {
          cwd: "/var/www/html",
          timeoutMs: 30_000,
        });
        await Promise.race([serverExit, delay(10_000)]);
      } catch (err) {
        const diagnostics = collectHostMariaDbDiagnostics(session.hostDataDir);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${message}\n${diagnostics}`);
      } finally {
        if (mariadbPid !== 0 && await isProcessLive(session.host, mariadbPid)) {
          await session.host.terminateProcess(mariadbPid, 0).catch(() => {});
          await Promise.race([serverExit, delay(2_000)]).catch(() => {});
        }
      }

      const written = ingestHostDirectory(session.hostDataDir, fs, "/data");
      assertVfsPath(fs, "/data/mysql");
      assertVfsPath(fs, "/data/wordpress");
      ensureMariaDbDataOwnership(fs);
      console.log(`[wp-preinstall:mariadb] wrote ${written} /data entries`);
    }, {
      maxWorkers: 16,
      dataBufferSize: 256 * 1024,
      mountDataDir: true,
      hostDataDir,
      programs,
    });
  } finally {
    rmSync(hostDataDir, { recursive: true, force: true });
  }
}

async function withKernelSession(
  fs: MemoryFileSystem,
  fn: (session: KernelSession) => Promise<void>,
  hostOptions: PreinstallKernelHostOptions = {},
): Promise<void> {
  const imageBytes = await saveShellDerivedBuildGuestSnapshot(fs);
  const hostDumpDir = mkdtempSync(join(tmpdir(), "wp-preinstall-dump-"));
  const hostDataDir = hostOptions.mountDataDir
    ? hostOptions.hostDataDir ?? mkdtempSync(join(tmpdir(), "wp-preinstall-data-"))
    : undefined;
  const removeHostDataDir = hostOptions.mountDataDir && hostOptions.hostDataDir === undefined;
  if (hostDataDir) chmodSync(hostDataDir, 0o777);
  const {
    mountDataDir: _mountDataDir,
    hostDataDir: _hostDataDir,
    programs,
    ...nodeHostOptions
  } = hostOptions;
  let activeStdoutSink: ((data: Uint8Array) => void) | null = null;
  let activeStdoutLabel = "";
  const host = new NodeKernelHost({
    ...nodeHostOptions,
    extraMounts: [
      ...(nodeHostOptions.extraMounts ?? []),
      { mountPoint: "/host-dump", hostPath: hostDumpDir },
      ...(hostDataDir ? [{ mountPoint: "/data", hostPath: hostDataDir }] : []),
    ],
    rootfsImage: imageBytes,
    // MariaDB and PHP both fork, so this build-time boot exercises the
    // co-resident fork module — the unconditional fork reconstructor the kernel
    // worker ships to every process worker. Inject the staged artifact
    // explicitly (like the kernel below): this boot runs under the source-only
    // resolution policy with no source-only binary root, so the kernel worker
    // resolving the fork module through the binary resolver would fail.
    forkModuleBytesByWidth: { 4: loadStagedForkModule32() },
    onStdout: (_pid, data) => {
      activeStdoutSink?.(new Uint8Array(data));
    },
    onStderr: (_pid, data) => {
      const text = new TextDecoder().decode(data);
      if (text.trim().length === 0) return;
      process.stderr.write(activeStdoutLabel ? `[wp-preinstall:${activeStdoutLabel}] ${text}` : text);
    },
  });

  try {
    await host.init(programs === undefined
      ? undefined
      : exactProgramBuffer(programs.kernel, "WordPress kernel"));
    const phpBytes = programs === undefined
      ? loadProgram("programs/php/php.wasm")
      : exactProgramBuffer(programs.php, "WordPress PHP");
    const session: KernelSession = {
      host,
      hostDataDir,
      runPhp: async (phase, script, opts = {}) => {
        const chunks: Uint8Array[] = [];
        activeStdoutLabel = phase;
        activeStdoutSink = (data) => chunks.push(data);
        try {
          const exitCode = await withTimeout(
            host.spawn(
              phpBytes,
              [...PHP_ARGS, script],
              {
                env: BASE_ENV,
                cwd: opts.cwd,
                uid: opts.uid,
                gid: opts.gid,
              },
            ),
            opts.timeoutMs ?? 120_000,
            `php ${phase} timed out`,
          );
          if (exitCode !== 0) {
            const stdout = new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks));
            throw new Error(`php ${phase} exited with code ${exitCode}${stdout ? `\n${stdout.slice(-4096)}` : ""}`);
          }
          return concatChunks(chunks);
        } finally {
          activeStdoutSink = null;
          activeStdoutLabel = "";
        }
      },
      runPhpToHostFile: async (phase, script, fileName, opts = {}) => {
        const hostPath = join(hostDumpDir, fileName);
        rmSync(hostPath, { force: true });
        await session.runPhp(phase, script, opts);
        const bytes = readFileSync(hostPath);
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      },
      runProgram: async (phase, bytes, argv, opts = {}) => {
        activeStdoutLabel = phase;
        try {
          const exitCode = await withTimeout(
            host.spawn(bytes, argv, {
              env: BASE_ENV,
              cwd: opts.cwd,
            }),
            opts.timeoutMs ?? 120_000,
            `${phase} timed out`,
          );
          if (exitCode !== 0) {
            throw new Error(`${phase} exited with code ${exitCode}`);
          }
          return exitCode;
        } finally {
          activeStdoutLabel = "";
        }
      },
    };
    await fn(session);
  } finally {
    await host.destroy().catch(() => {});
    rmSync(hostDumpDir, { recursive: true, force: true });
    if (hostDataDir && removeHostDataDir) rmSync(hostDataDir, { recursive: true, force: true });
  }
}

function loadProgram(binaryId: string): ArrayBuffer {
  const bytes = readFileSync(resolveBinary(binaryId));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
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
  return new Uint8Array(readFileSync(join(repoRoot, "host/wasm/fork_module32.wasm")));
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

function mariadbServerArgs(): string[] {
  return [
    "--no-defaults",
    "--user=mysql",
    "--datadir=/data",
    "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria",
    `--aria-log-file-size=${MARIADB_ARIA_LOG_FILE_SIZE}`,
    `--aria-pagecache-buffer-size=${MARIADB_ARIA_PAGECACHE_SIZE}`,
    `--innodb-log-file-size=${MARIADB_INNODB_LOG_FILE_SIZE}`,
    `--innodb-log-buffer-size=${MARIADB_INNODB_LOG_BUFFER_SIZE}`,
    `--innodb-buffer-pool-size=${MARIADB_INNODB_BUFFER_POOL_SIZE}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
    "--skip-networking",
    `--socket=${MARIADB_PREINSTALL_SOCKET_PATH}`,
    "--max-connections=10",
    "--log-error=/data/error.log",
  ];
}

function mariadbBootstrapArgs(): string[] {
  return [
    "--no-defaults",
    "--user=mysql",
    "--datadir=/data",
    "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria",
    `--aria-log-file-size=${MARIADB_ARIA_LOG_FILE_SIZE}`,
    `--aria-pagecache-buffer-size=${MARIADB_ARIA_PAGECACHE_SIZE}`,
    `--innodb-log-file-size=${MARIADB_INNODB_LOG_FILE_SIZE}`,
    `--innodb-log-buffer-size=${MARIADB_INNODB_LOG_BUFFER_SIZE}`,
    `--innodb-buffer-pool-size=${MARIADB_INNODB_BUFFER_POOL_SIZE}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
    "--bootstrap",
    "--skip-networking",
    "--log-warnings=0",
    "--log-error=/data/bootstrap.log",
  ];
}

function prepareHostMariaDbDataDir(hostDataDir: string): void {
  chmodSync(hostDataDir, 0o777);
  for (const dir of ["mysql", "tmp", "test"]) {
    const path = join(hostDataDir, dir);
    mkdirSync(path, { recursive: true, mode: 0o777 });
    chmodSync(path, 0o777);
  }
}

function makeHostMariaDbDataWritable(hostDataDir: string): void {
  function walk(path: string): void {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(path, 0o777);
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (st.isFile()) {
      chmodSync(path, 0o666);
    }
  }
  walk(hostDataDir);
}

async function bootstrapMariaDbSystemTables(
  session: KernelSession,
  fs: MemoryFileSystem,
  mariadbBytes: ArrayBuffer,
): Promise<void> {
  if (!session.hostDataDir) {
    throw new Error("MariaDB bootstrap requires hostDataDir");
  }
  const bootstrapSql = readVfsFile(fs, "/etc/mariadb/bootstrap.sql");
  let bootstrapPid = 0;
  let resolveStarted!: (pid: number) => void;
  const started = new Promise<number>((resolve) => { resolveStarted = resolve; });
  const bootstrapExit = session.host.spawn(
    mariadbBytes,
    ["mariadbd", ...mariadbBootstrapArgs()],
    {
      env: BASE_ENV,
      cwd: "/data",
      stdin: bootstrapSql,
      onStarted: (pid) => {
        bootstrapPid = pid;
        resolveStarted(pid);
      },
    },
  );
  bootstrapExit.catch(() => {});
  await withTimeout(started, 10_000, "mariadbd bootstrap did not start");

  const wordpressDataDir = join(session.hostDataDir, "wordpress");
  try {
    await Promise.race([
      waitForHostPath(wordpressDataDir, 120_000),
      bootstrapExit.then((code) => {
        if (code === 0 && hostPathExists(wordpressDataDir)) return;
        throw new Error(`mariadbd bootstrap exited before creating wordpress database with code ${code}`);
      }),
    ]);
    if (!hostPathExists(wordpressDataDir)) {
      await waitForHostPath(wordpressDataDir, 2_000);
    }
    await delay(60_000);
  } catch (err) {
    const diagnostics = collectHostMariaDbDiagnostics(session.hostDataDir);
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${message}\n${diagnostics}`);
  } finally {
    if (bootstrapPid !== 0 && await isProcessLive(session.host, bootstrapPid)) {
      await session.host.terminateProcess(bootstrapPid, 0).catch(() => {});
      await Promise.race([bootstrapExit, delay(2_000)]).catch(() => {});
    }
  }
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let offset = 0;
    while (offset < out.byteLength) {
      const n = fs.read(fd, out.subarray(offset), null, out.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.subarray(0, offset);
  } finally {
    fs.close(fd);
  }
}

function wordpressInstallScript(): string {
  return `
$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['SERVER_NAME'] = 'localhost';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI'] = '/wp-admin/install.php';

define('WP_INSTALLING', true);
require_once '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';

if (is_blog_installed()) {
    echo "already installed\\n";
    exit(0);
}

$result = wp_install(
    ${phpString(WORDPRESS_DEFAULT_SITE_TITLE)},
    ${phpString(WORDPRESS_DEFAULT_ADMIN_USER)},
    ${phpString(WORDPRESS_DEFAULT_ADMIN_EMAIL)},
    true,
    '',
    ${phpString(WORDPRESS_DEFAULT_ADMIN_PASSWORD)},
    'en_US'
);

if (is_wp_error($result)) {
    fwrite(STDERR, $result->get_error_message() . "\\n");
    exit(1);
}

update_option('blogdescription', '');
update_option('timezone_string', 'UTC');
wp_cache_flush();
echo "installed user_id=" . (int)($result['user_id'] ?? 0) . "\\n";
`.trim();
}

function waitForMariaDbSocketCommand(): string {
  return `
i=0
while [ $i -lt 180 ]; do
    if [ -e ${MARIADB_SOCKET_PATH} ]; then
        sleep 5
        exit 0
    fi
    sleep 1
    i=$((i + 1))
done
echo "MariaDB socket did not appear at ${MARIADB_SOCKET_PATH}" >&2
exit 1
`.trim();
}

function mariaDbDiagnosticsScript(): string {
  return `
foreach (['/data/bootstrap.log', '/data/error.log'] as $path) {
    echo "== $path ==\\n";
    if (is_file($path)) {
        $text = file_get_contents($path);
        echo substr($text, -6000) . "\\n";
    } else {
        echo "missing\\n";
    }
}
echo "== /data ==\\n";
if (is_dir('/data')) {
    foreach (scandir('/data') as $entry) {
        if ($entry === '.' || $entry === '..') continue;
        $path = '/data/' . $entry;
        $st = @stat($path);
        echo $entry . " mode=" . decoct(($st['mode'] ?? 0) & 07777) . " size=" . ($st['size'] ?? 0) . "\\n";
    }
} else {
    echo "missing\\n";
}
`.trim();
}

async function collectMariaDbDiagnostics(session: KernelSession): Promise<string> {
  const out = await session.runPhp("MariaDB diagnostics", mariaDbDiagnosticsScript(), {
    cwd: "/",
    timeoutMs: 15_000,
  });
  return new TextDecoder("utf-8", { fatal: false }).decode(out);
}

function shutdownMariaDbScript(): string {
  return `
mysqli_report(MYSQLI_REPORT_OFF);
$db = mysqli_init();
if (!$db || !@mysqli_real_connect($db, 'localhost', 'root', '', '', 0, ${phpString(MARIADB_PREINSTALL_SOCKET_PATH)})) {
    fwrite(STDERR, "MariaDB shutdown skipped: " . mysqli_connect_error() . "\\n");
    exit(0);
}
@$db->query('FLUSH TABLES');
@$db->query('SHUTDOWN');
echo "mariadb shutdown requested\\n";
exit(0);
`.trim();
}

function dumpScript(paths: string[], outputPath?: string): string {
  return `
$roots = json_decode(${phpString(JSON.stringify(paths))}, true);
$dumpOutputPath = ${outputPath === undefined ? "null" : phpString(outputPath)};
$dumpHandle = $dumpOutputPath === null ? fopen('php://stdout', 'wb') : fopen($dumpOutputPath, 'wb');
if (!$dumpHandle) {
    fwrite(STDERR, "cannot open dump output\\n");
    exit(2);
}
$records = [];

function write_dump($text) {
    global $dumpHandle;
    if (fwrite($dumpHandle, $text) === false) {
        fwrite(STDERR, "cannot write dump output\\n");
        exit(2);
    }
}

function add_dump_record($path, &$records) {
    if (is_link($path)) {
        return;
    }
    $st = @stat($path);
    if ($st === false) {
        fwrite(STDERR, "missing dump path: $path\\n");
        exit(2);
    }
    $mode = $st['mode'] & 07777;
    $uid = $st['uid'] ?? 0;
    $gid = $st['gid'] ?? 0;

    if (is_dir($path)) {
        $records[] = ['dir', $path, $mode, $uid, $gid, ''];
        $children = @scandir($path);
        if ($children === false) {
            fwrite(STDERR, "cannot read directory: $path\\n");
            exit(2);
        }
        sort($children, SORT_STRING);
        foreach ($children as $child) {
            if ($child === '.' || $child === '..') {
                continue;
            }
            add_dump_record(rtrim($path, '/') . '/' . $child, $records);
        }
        return;
    }

    if (is_file($path)) {
        $content = @file_get_contents($path);
        if ($content === false) {
            fwrite(STDERR, "cannot read file: $path\\n");
            exit(2);
        }
        $records[] = ['file', $path, $mode, $uid, $gid, base64_encode($content)];
    }
}

foreach ($roots as $root) {
    add_dump_record($root, $records);
}

write_dump("===WPDB_DUMP_BEGIN===\\n");
write_dump(count($records) . "\\n");
foreach ($records as $record) {
    write_dump($record[0] . "\\n");
    write_dump(base64_encode($record[1]) . "\\n");
    write_dump($record[2] . "\\n");
    write_dump($record[3] . "\\n");
    write_dump($record[4] . "\\n");
    write_dump($record[5] . "\\n");
}
write_dump("===WPDB_DUMP_END===\\n");
fclose($dumpHandle);
fwrite(STDERR, "dumped " . count($records) . " entries\\n");
`.trim();
}

function ingestDump(buf: Uint8Array, fs: MemoryFileSystem): number {
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(DUMP_BEGIN);
  if (beginAt < 0) {
    throw new Error(
      "WPDB_DUMP_BEGIN marker not found in stdout\n" +
        `stdout bytes=${buf.byteLength}\n` +
        text.slice(-4096),
    );
  }
  const body = text.substring(beginAt + DUMP_BEGIN.length);
  const lines = body.split("\n");
  const count = Number.parseInt(lines[0] ?? "", 10);
  if (!Number.isFinite(count)) {
    throw new Error(`bad dump record count: ${JSON.stringify(lines[0])}`);
  }

  let cursor = 1;
  const records: DumpRecord[] = [];
  for (let i = 0; i < count; i++) {
    const type = lines[cursor++] as "dir" | "file";
    const path = decodeBase64Text(requiredLine(lines, cursor++, "path"));
    const mode = Number.parseInt(requiredLine(lines, cursor++, "mode"), 10);
    const uid = Number.parseInt(requiredLine(lines, cursor++, "uid"), 10);
    const gid = Number.parseInt(requiredLine(lines, cursor++, "gid"), 10);
    const contentLine = requiredLine(lines, cursor++, "content");
    if (type !== "dir" && type !== "file") {
      throw new Error(`bad dump record type: ${JSON.stringify(type)}`);
    }
    records.push({
      type,
      path,
      mode,
      uid,
      gid,
      content: type === "file" ? decodeBase64Bytes(contentLine) : undefined,
    });
  }
  if (lines[cursor] !== DUMP_END) {
    throw new Error(`missing WPDB_DUMP_END marker (got ${JSON.stringify(lines[cursor])})`);
  }

  for (const record of records) {
    if (record.type !== "dir") continue;
    ensureDirRecursive(fs, record.path);
    fs.chown(record.path, record.uid, record.gid);
    fs.chmod(record.path, record.mode);
  }
  for (const record of records) {
    if (record.type !== "file") continue;
    ensureDirRecursive(fs, dirname(record.path));
    writeVfsBinary(fs, record.path, record.content ?? new Uint8Array(), record.mode);
    fs.chown(record.path, record.uid, record.gid);
    fs.chmod(record.path, record.mode);
  }

  return records.length;
}

function ingestHostDirectory(hostRoot: string, fs: MemoryFileSystem, vfsRoot: string): number {
  let written = 0;

  function copyDir(hostDir: string, vfsDir: string): void {
    const st = lstatSync(hostDir);
    ensureDirRecursive(fs, vfsDir);
    fs.chown(vfsDir, MYSQL_UID, MYSQL_GID);
    fs.chmod(vfsDir, st.mode & 0o7777);
    written++;

    for (const name of readdirSync(hostDir)) {
      const hostPath = join(hostDir, name);
      const vfsPath = `${vfsDir.replace(/\/+$/, "")}/${name}`;
      const childSt = lstatSync(hostPath);
      if (childSt.isSymbolicLink()) continue;
      if (childSt.isDirectory()) {
        copyDir(hostPath, vfsPath);
      } else if (childSt.isFile()) {
        writeVfsBinary(fs, vfsPath, new Uint8Array(readFileSync(hostPath)), childSt.mode & 0o7777);
        fs.chown(vfsPath, MYSQL_UID, MYSQL_GID);
        fs.chmod(vfsPath, childSt.mode & 0o7777);
        written++;
      }
    }
  }

  copyDir(hostRoot, vfsRoot);
  return written;
}

function collectHostMariaDbDiagnostics(hostDataDir: string): string {
  const chunks: string[] = [];
  for (const name of ["bootstrap.log", "error.log"]) {
    const path = join(hostDataDir, name);
    chunks.push(`== /data/${name} ==`);
    try {
      chunks.push(readFileSync(path, "utf-8").slice(-6000));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      chunks.push(`missing (${message})`);
    }
  }
  chunks.push("== /data ==");
  try {
    for (const name of readdirSync(hostDataDir).sort()) {
      const st = lstatSync(join(hostDataDir, name));
      chunks.push(`${name} mode=${(st.mode & 0o7777).toString(8)} size=${st.size}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    chunks.push(`cannot list (${message})`);
  }
  return chunks.join("\n");
}

function ensureMariaDbDataOwnership(fs: MemoryFileSystem): void {
  for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/wordpress"]) {
    try {
      fs.chown(dir, MYSQL_UID, MYSQL_GID);
      fs.chmod(dir, 0o775);
    } catch {
      // assertVfsPath reports missing required directories separately.
    }
  }
}

function assertVfsPath(fs: MemoryFileSystem, path: string): void {
  try {
    fs.stat(path);
  } catch {
    throw new Error(`expected preinstalled WordPress artifact missing: ${path}`);
  }
}

async function isProcessLive(host: NodeKernelHost, pid: number): Promise<boolean> {
  const procs = await host.enumProcs().catch(() => []);
  return procs.some((proc) => proc.pid === pid);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const buf = Buffer.from(value, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function decodeBase64Text(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

function requiredLine(lines: string[], index: number, label: string): string {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`truncated dump record while reading ${label}`);
  }
  return line;
}

function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHostPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      lstatSync(path);
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error(`timed out waiting for host path: ${path}`);
}

function hostPathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
