/*
 * Real vfork (N1 residual), execve variant: the vfork CHILD calls `execve`
 * instead of `_exit` — proving the parent's own channel is deferred all the
 * way to a successful exec commit (`handle_exec_common`'s release hook in
 * `crates/host-native/src/guest.rs`), not just to the child's own `_exit`
 * (already covered by `native_vfork.c`/`smoke_vfork_exit_shares_memory`).
 *
 * The exec TARGET is the existing `native_exec_target.wasm` fixture
 * (`fixtures/native_exec_target.c`), placed at `/bin/exectarget` in the
 * `BaseImage` exactly like `smoke_execve_replaces_image` — it writes
 * "exec ok\n" and `_exit(9)`. Once `execve` commits, this vfork child runs a
 * BRAND-NEW, private (never shared) image under the SAME pid — POSIX vfork's
 * contract that the borrow ends at exec — and the parent's OWN later
 * `waitpid` reaps that image's real exit status through the ordinary,
 * unrelated wait4 path.
 *
 * `marker` (like `native_fork.c`/`native_vfork.c`) is a genuinely live local
 * that must survive the borrowed child's replayed frame up to the `execve`
 * call site.
 */
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
    volatile int marker = 42;
    pid_t p = vfork();
    if (p == 0) {
        char *argv[] = { "/bin/exectarget", (char *)0 };
        char *envp[] = { (char *)0 };
        execve("/bin/exectarget", argv, envp);
        // execve failed: this vfork child must not fall back to anything
        // else (POSIX permits only exec-family or `_exit` here).
        write(1, "vfork child execve failed\n", 27);
        _exit(66);
    } else {
        int st;
        waitpid(p, &st, 0);
        write(1, "parent\n", 7);
        _exit(marker == 42 ? WEXITSTATUS(st) : 9);
    }
}
