/*
 * Pipe round-trip guest for the native Wasmtime host's increment-4 smoke test.
 *
 * This exercises the one marshalling direction the earlier fixtures do not: a
 * RAW syscall with an *Out* pointer buffer that the kernel fills and the host
 * must copy back to the guest. `write` (increment 2) is In-only; `uname`
 * (increment 3) is a record-path Out. Here:
 *
 *   - pipe(fds)          — record-path, writes the two fds into an Out span;
 *   - write(fds[1], msg) — RAW, In buffer, into the in-kernel pipe (no host);
 *   - read(fds[0], buf)  — RAW, Out buffer: the kernel copies the piped bytes
 *                          into the kernel scratch and the host copies them back
 *                          into the guest's buffer;
 *   - write(1, buf, r)   — RAW, In buffer, to stdout via host_write.
 *
 * A correct final line proves the RAW Out copy-back works and that in-kernel
 * pipe I/O round-trips on a non-JS engine. The write precedes the read and the
 * message is far smaller than the pipe buffer, so neither blocks.
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <string.h>
#include <unistd.h>

int main(void) {
    int fds[2];
    if (pipe(fds) != 0) {
        return 2;
    }
    static const char msg[] = "piped through the native host\n";
    size_t n = sizeof(msg) - 1;
    if (write(fds[1], msg, n) != (ssize_t)n) {
        return 3;
    }
    char buf[64];
    ssize_t r = read(fds[0], buf, sizeof(buf));
    if (r != (ssize_t)n) {
        return 4;
    }
    write(1, buf, (size_t)r);
    return 0;
}
