/*
 * N1-I4 Task 2: a REAL `fork()` — the guest calls `kernel.kernel_fork` DIRECTLY
 * (`libc/glue/channel_syscall.c:492-493,577-600), never through the generic
 * syscall dispatcher. The parent waits for the child and reports its decoded
 * `WEXITSTATUS`; the child (if it ever actually runs) writes "child\n" and
 * exits 3.
 *
 * Task 2's host-native scope does NOT yet drive the fm_* capture/replay
 * coordinator (Task 3) that would let the child resume execution at this
 * fork() call site, so on that host the child process is created (private
 * memory copy, guest `Instance`, co-resident fork-module) but never actually
 * runs any of this program — see `spawn_guest_thread`'s
 * `fork_child_pending_replay` doc comment. The PARENT side is fully real:
 * `fork()` returns the child's pid, `waitpid()` reaps it through the same
 * `wait_table`/parked-retry machinery `posix_spawn` already uses, and
 * "parent\n" is printed with the reaped `WEXITSTATUS`.
 *
 * N1-I4 Task 3: `marker` is declared BEFORE `fork()` and read AFTER it, in
 * BOTH branches — a genuinely live local that must survive the capture/
 * replay round trip (unlike `p`, which is only ASSIGNED from `fork()`'s
 * return value and so needs no frame preservation at all). This is what
 * forces the co-resident fork-module to actually commit and replay a real
 * frame for `main()`'s own call site (`fm_frames_committed`/`fm_frames_
 * replayed` — see `crates/host-native/src/lib.rs`'s `smoke_fork_parent_
 * child`); the exit code diverges (9 instead of the intended 3) if `marker`
 * is ever NOT correctly restored, a truthful, detectable proof that this
 * fixture actually exercises frame preservation rather than merely a
 * trivial fork-with-no-live-state.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    // `volatile`: without it, -O2 proves `marker == 42` is always true from
    // pure straight-line dataflow (nothing in a single compiled translation
    // unit "changes" it around the `fork()` call) and constant-folds the
    // whole check away, which would silently defeat the "genuinely live
    // local" property this fixture exists to exercise — see this file's
    // top-of-file doc comment.
    volatile int marker = 42;
    pid_t p = fork();
    if (p == 0) {
        write(1, "child\n", 6);
        _exit(marker == 42 ? 3 : 9);
    } else {
        int st;
        waitpid(p, &st, 0);
        write(1, "parent\n", 7);
        _exit(marker == 42 ? WEXITSTATUS(st) : 9);
    }
}
