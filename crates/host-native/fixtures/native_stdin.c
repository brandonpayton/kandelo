/*
 * Blocking-read guest for the native Wasmtime host (Phase 4, readiness-driven
 * blocking on a single channel).
 *
 * A read on stdin blocks until input is ready. The native host serves stdin as
 * a source that is EAGAIN on the first read and delivers a line on the next, so
 * the kernel returns EAGAIN, the pump parks the read (acquiring a retry token),
 * and a later re-dispatch picks up the delivered data. This exercises the
 * readiness-driven blocking path — a would-block read that completes when the
 * host makes it ready — with no timeout and no second thread yet.
 *
 * A correct run echoes the delivered line.
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <unistd.h>

int main(void) {
    char buf[64];
    ssize_t r = read(0, buf, sizeof(buf));
    if (r <= 0) {
        return 2;
    }
    write(1, buf, (size_t)r);
    return 0;
}
