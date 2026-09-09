/*
 * Blocking-poll guest for the native Wasmtime host's Phase 4 (blocking) test.
 *
 * poll(NULL, 0, timeout) with no fds is the smallest blocking syscall: it has
 * no readiness sources and no cross-process concurrency, so it exercises the
 * host's wait/retry loop purely on the timeout path. The kernel returns EAGAIN
 * while it would block; the native host must park until the deadline and then
 * force a non-blocking re-check so the kernel returns 0 (timed out, no fds).
 *
 * A correct run returns 0 from poll after roughly the requested delay.
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <poll.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    int r = poll((struct pollfd *)0, 0, 60);
    if (r != 0) {
        return 2;
    }
    write(1, "poll timed out\n", 15);
    return 0;
}
