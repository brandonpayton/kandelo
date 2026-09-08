# bun-run.js

`bun-run.js` is the Kandelo bootstrap that runs a Bun-compiled standalone
executable on `spidermonkey-node`. It shells out to `bun-extract --prepare
<binary> <cache-root>` to extract (or reuse a cached extraction of) the
executable's embedded module graph, installs a thin `globalThis.Bun` shim and
`globalThis.__breq` module-require helper that the extracted app expects at
runtime, rewrites `process.argv` to the app's own view (`[node, entry,
...appArgs]`), and then natively `import()`s the cached `.mjs` entry point in
the current process. It is invoked as `node /usr/lib/kandelo/bun-run.js
<bun-executable> [app args...]` and exits non-zero with a `bun-run: ...`
message on stderr if extraction fails, the input isn't a recognizable Bun
executable, or the app's entry module fails to load — it never fails silently.
