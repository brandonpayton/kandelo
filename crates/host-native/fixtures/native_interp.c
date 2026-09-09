/*
 * N1-I3d Task 2: the `#!` shebang INTERPRETER image. Proves the host's
 * `resolve_shebang` step actually retargeted the exec onto THIS program
 * (rather than trying to `Module::new` the `#!` script's own bytes, which
 * would fail `ENOEXEC` per I3c) and assembled the right argv: it prints its
 * own `argv` array, one entry per line as `"argv[N]=<value>\n"`, then exits
 * 0. The host test asserts on the printed argv values/order rather than the
 * exit code alone, since a wrong argv assembly (missing the script's own
 * path, dropping the interpreter's `#!` argument, or misordering entries)
 * would otherwise still exit 0.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    for (int i = 0; i < argc; i++) {
        char line[256];
        int n = snprintf(line, sizeof(line), "argv[%d]=%s\n", i, argv[i]);
        if (n > 0) {
            write(1, line, (size_t)n);
        }
    }
    _exit(0);
}
