/*
 * N1 residual #4a (non-main-thread `fork()`): the SAME real-fork proof as
 * `native_fork.c`, except `fork()` is called from a PTHREAD, never the main
 * thread. Before this task, `kernel.kernel_fork` was not wired at all on a
 * worker thread's own `Store` — a worker-thread `fork()` hit an unknown-
 * import trap that silently ended the OS thread (no POSIX-shaped error, no
 * channel post), which would hang `pthread_join` on it forever. A correct
 * host must let `forker`'s `fork()` behave exactly like `native_fork.c`'s
 * main-thread one: the child prints "child\n" and exits 3; the PARENT
 * (the pthread, not `main`) reaps it and returns its real `WEXITSTATUS`
 * through `pthread_join`, which `main` then turns into the process exit
 * code. If the pthread's OS thread were silently killed instead, `pthread_
 * join` below would never return and this fixture would never reach its
 * own `_exit` — the pump's 30s hard cap is what would eventually surface
 * that RED state as a timed-out `run_guest` call, not a true hang.
 *
 * `marker` mirrors `native_fork.c`'s own "genuinely live local across the
 * capture/replay round trip" proof, `volatile` for the same reason (see
 * that file's doc comment).
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 * Instrumented like `native_fork.instrumented.wasm` (this is the whole
 * point of this fixture: proving `fork()` works from a thread on a
 * fork-INSTRUMENTED guest, the only guest shape that ever drives the real
 * capture/replay coordinator this task wires onto a worker thread's Store).
 */
#include <pthread.h>
#include <sys/wait.h>
#include <unistd.h>

static void *forker(void *arg) {
    (void)arg;
    volatile int marker = 42;
    pid_t p = fork();
    if (p == 0) {
        write(1, "child\n", 6);
        _exit(marker == 42 ? 3 : 9);
    }
    int st;
    waitpid(p, &st, 0);
    write(1, "parent\n", 7);
    return (void *)(long)(marker == 42 ? WEXITSTATUS(st) : 9);
}

int main(void) {
    pthread_t t;
    if (pthread_create(&t, (void *)0, forker, (void *)0) != 0) {
        return 10;
    }
    void *ret;
    if (pthread_join(t, &ret) != 0) {
        return 11;
    }
    write(1, "joined\n", 7);
    return (int)(long)ret;
}
