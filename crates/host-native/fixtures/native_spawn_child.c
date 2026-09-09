/*
 * N1-I3a Task 2: the posix_spawn CHILD side. A trivial program that proves it
 * really ran as its OWN process (not the parent, not a fork continuation): it
 * writes a known line to stdout, then exits with a distinctive status the
 * parent can eventually check via waitpid (Task 3 — this increment does not
 * assert on it yet, since waitpid isn't serviced).
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <unistd.h>

int main(void) {
    write(1, "child ok\n", 9);
    _exit(7);
}
