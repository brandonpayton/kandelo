/*
 * epoll guest for the native Wasmtime host (Phase 4, epoll readiness).
 *
 * The Phase 2 flip and the browser/Node host both leave epoll's readiness the
 * one place still reimplemented in host TypeScript: epoll_pwait is converted to
 * a host-built poll and never reaches the kernel's sys_epoll_pwait (a Chrome V8
 * crash workaround). Before moving that decision back into the kernel for the JS
 * hosts, this proves the kernel's own epoll path is sound when driven through
 * the real channel on a non-V8 engine.
 *
 * It exercises the kernel's epoll *readiness computation* directly:
 *
 *   - epoll_create1()                 — RAW, returns an epoll fd;
 *   - pipe(fds) + write(fds[1], "x")  — make the read end readable;
 *   - epoll_ctl(ADD, fds[0], EPOLLIN) — register interest (In epoll_event);
 *   - epoll_pwait(epfd, evs, 4, 1000) — the kernel detects the readable pipe
 *                                       and returns it (Out epoll_event array).
 *
 * A correct run reports exactly one ready fd carrying EPOLLIN — proving the
 * kernel decided readiness (not a host reimplementation).
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <string.h>
#include <sys/epoll.h>
#include <unistd.h>

int main(void) {
    int epfd = epoll_create1(0);
    if (epfd < 0) {
        return 2;
    }
    int fds[2];
    if (pipe(fds) != 0) {
        return 3;
    }
    if (write(fds[1], "x", 1) != 1) {
        return 4;
    }
    struct epoll_event ev;
    memset(&ev, 0, sizeof(ev));
    ev.events = EPOLLIN;
    ev.data.fd = fds[0];
    if (epoll_ctl(epfd, EPOLL_CTL_ADD, fds[0], &ev) != 0) {
        return 5;
    }
    struct epoll_event evs[4];
    int n = epoll_wait(epfd, evs, 4, 1000);
    if (n != 1) {
        return 6;
    }
    if (!(evs[0].events & EPOLLIN)) {
        return 7;
    }
    write(1, "epoll ready\n", 12);
    return 0;
}
