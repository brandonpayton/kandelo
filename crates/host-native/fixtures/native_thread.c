/*
 * Two-thread blocking guest for the native Wasmtime host (Phase 4, readiness-
 * driven blocking woken across threads).
 *
 * The main thread creates a pipe and a second (writer) thread, then blocks in
 * read() on the empty pipe. The writer writes to the pipe, which makes the read
 * end readable and wakes the blocked read. This is the scenario the multi-
 * channel pump exists for: the reader's blocked read must not monopolize the
 * pump, or the writer's write — the thing that unblocks it — could never run.
 *
 * After writing, the writer blocks forever on a second, never-written pipe
 * rather than returning. This keeps the test focused on the pump: a returning
 * pthread would run musl's detached-thread teardown (__pthread_exit /
 * __unmapself), which needs thread-teardown machinery the minimal native host
 * does not provide yet. The main thread finishes its read and exits; the
 * process ends, reclaiming the parked writer thread.
 *
 * A correct run echoes the line the writer sent.
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <pthread.h>
#include <unistd.h>

static int g_write_fd;
static int g_block_fd;

static void *writer(void *arg) {
    (void)arg;
    write(g_write_fd, "woken by thread\n", 16);
    // Block forever on a pipe nobody writes, so this thread never runs pthread
    // teardown. The process exit from main reclaims it.
    char b;
    (void)read(g_block_fd, &b, 1);
    return (void *)0;
}

int main(void) {
    int fds[2];
    int block[2];
    if (pipe(fds) != 0 || pipe(block) != 0) {
        return 2;
    }
    g_write_fd = fds[1];
    g_block_fd = block[0];

    pthread_t t;
    if (pthread_create(&t, (void *)0, writer, (void *)0) != 0) {
        return 3;
    }

    char buf[64];
    ssize_t r = read(fds[0], buf, sizeof(buf));
    if (r <= 0) {
        return 4;
    }
    write(1, buf, (size_t)r);
    return 0;
}
