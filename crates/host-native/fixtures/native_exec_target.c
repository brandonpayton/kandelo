/*
 * N1-I3c Task 1: the `execve` TARGET image. A trivial program that proves it
 * really is a brand-new image running under the SAME pid the parent
 * `execve`'d from (not the parent continuing, not a fork): it writes a
 * known line to stdout, then exits with a distinctive status the host test
 * checks directly as the PROCESS's exit code (execve replaces the image in
 * place, so there is no separate child to `waitpid` — unlike posix_spawn's
 * `native_spawn_child.c`).
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <unistd.h>

int main(void) {
    write(1, "exec ok\n", 8);
    _exit(9);
}
