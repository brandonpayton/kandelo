/*
 * bun-run: thin entrypoint that hands a Bun standalone executable to the
 * Kandelo `bun-run.js` bootstrap running on spidermonkey-node.
 *
 * `bun-run.js` (runtime/bun-run/bun-run.js, installed at
 * /usr/lib/kandelo/bun-run.js) spawns `bun-extract --prepare` to extract the
 * plaintext ESM module graph from the target Bun executable, installs a thin
 * `Bun` global shim, and natively `import()`s the cached entry point. This
 * program is just argv passthrough: it execs spidermonkey-node with the
 * bootstrap script and the caller's arguments, so `bun-run <binary> [args]`
 * behaves like running <binary> directly (e.g. as a future binfmt target).
 *
 * usage: bun-run <bun-executable> [args...]
 */
#include <unistd.h>
#include <string.h>

int main(int argc, char **argv) {
    /* bun-run <binary> [args...] -> spidermonkey-node /usr/lib/kandelo/bun-run.js <binary> [args...] */
    char *nargv[argc + 3];
    nargv[0] = "spidermonkey-node";
    nargv[1] = "/usr/lib/kandelo/bun-run.js";
    for (int i = 1; i < argc; i++) nargv[i + 1] = argv[i];
    nargv[argc + 1] = 0;
    execv("/usr/bin/spidermonkey-node", nargv);
    return 127;
}
