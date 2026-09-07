"use strict";
// Kandelo bun-run bootstrap: extract (cached) + run a Bun executable on spidermonkey-node.
const cp = require("child_process");
const fs = require("fs");

const CACHE_ROOT = "/var/cache/kandelo/bun-run"; // volatile; never persisted (see spec)

function fail(msg, code) { process.stderr.write("bun-run: " + msg + "\n"); process.exit(code || 1); }

const binary = process.argv[2];
if (!binary) fail("usage: bun-run <bun-executable> [args...]", 2);
const appArgs = process.argv.slice(3);

// 1. Extract (cache-aware). One-shot; works with synchronous child_process today.
// NOTE: Kandelo's spidermonkey-node child_process shim ignores the `encoding`
// option and always hands back Buffers, so decode defensively with String()
// rather than assuming spawnSync gave us strings. It also never actually
// captures child stderr into result.stderr (always ''); `stdio: 'inherit'`
// for stderr makes the shim let bun-extract's own diagnostics (e.g. "not a
// Bun standalone executable...") flow straight through to our real stderr
// instead of being redirected to /dev/null, so a malformed-binary failure is
// not reduced to a bare "exit 1".
const r = cp.spawnSync("/usr/bin/bun-extract", ["--prepare", binary, CACHE_ROOT], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const rStdout = String(r.stdout || "");
if (r.status !== 0) fail("extract failed (exit " + r.status + "); see stderr above", 1);
const entry = (rStdout.match(/^ENTRY=(.+)$/m) || [])[1];
if (!entry) fail("could not determine entry point (not a Bun executable?)", 1);

// Install the per-file loader map so node-compat require() returns Bun-correct
// values for embedded assets (text -> string, file -> path, json -> object,
// napi -> honest throw). Keyed by absolute cache path to match require()'s
// realpath'd lookup (the cache has no symlinks). Missing/old manifests are
// tolerated: require() then behaves exactly as before.
const cache = (rStdout.match(/^CACHE=(.+)$/m) || [])[1];
if (cache) {
  try {
    const loaders = (JSON.parse(fs.readFileSync(cache + "/manifest.json", "utf8")) || {}).loaders;
    if (loaders && typeof loaders === "object") {
      const map = Object.create(null);
      for (const rel of Object.keys(loaders)) map[cache + "/" + rel] = loaders[rel];
      globalThis.__kandeloAssetLoaders = map;
    }
  } catch (_) { /* no loaders map: leave require() behavior unchanged */ }
}

// 2. Thin Bun-global shim. Unimplemented members throw named errors (never silent).
const ni = (name) => () => { throw new Error("Bun." + name + " not implemented (Kandelo bun-run shim)"); };
globalThis.__breq = (id) =>
  require(typeof id === "string" && id.indexOf("file://") === 0 ? require("url").fileURLToPath(id) : id);
globalThis.Bun = {
  version: (process.versions && process.versions.node) || "0",
  isStandaloneExecutable: false,
  which(cmd) { try { const o = cp.spawnSync("sh", ["-lc", "command -v " + cmd], { encoding: "utf8" }); return String(o.stdout || "").trim() || null; } catch (_) { return null; } },
  file(p) { return { text: () => fs.promises.readFile(p, "utf8"), arrayBuffer: () => fs.promises.readFile(p), exists: () => Promise.resolve(fs.existsSync(p)) }; },
  write() { return ni("write")(); },
  spawn: ni("spawn"), serve: ni("serve"),
  stringWidth: (s) => String(s).length,
  stripANSI: (s) => String(s).replace(/\x1b\[[0-9;]*m/g, ""),
  // zstd decompression via node-compat's zlib (native __kandeloZstdDecompress
  // seam). Compression is not implemented (libzstd is decompress-only).
  zstdDecompressSync: (bytes) => require("zlib").zstdDecompressSync(bytes),
  zstdDecompress: (bytes) => Promise.resolve(require("zlib").zstdDecompressSync(bytes)),
  gc() {}, deepEquals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
};

// 3. Present the app with its own argv, then load it natively.
process.argv = [process.argv[0], entry].concat(appArgs);
import(entry).catch((e) => fail((e && (e.stack || e.message)) || String(e), 1));
