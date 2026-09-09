/*
 * N1-I3c Task 1: the `execve` PARENT/caller side. Calls `execve` on
 * `/bin/exectarget` (placed in the `BaseImage`, resolved through the
 * kernel's exec-target authority against this SAME process's own
 * namespace). Per POSIX, a successful `execve` never returns to the caller
 * — it replaces the calling process's image in place. If it DOES return
 * (today's RED state: `SYS_EXECVE` falls through to the kernel's generic
 * dispatch, which has no handler for it and returns `-ENOSYS`), that is a
 * failure, so this fixture prints a line that must NEVER appear once
 * `execve` actually works, then exits 1 (a status the exec'd target never
 * uses, so the host test can tell the two outcomes apart even without the
 * stdout check).
 *
 * N1-I3c Task 2: the target path is configurable via the `EXEC_TEST_PATH`
 * environment variable so the same binary also drives the failure matrix
 * (missing path -> ENOENT, non-executable -> EACCES, non-wasm bytes ->
 * ENOEXEC). When `EXEC_TEST_PATH` is set, this fixture switches to "report
 * the errno `execve` returned with and keep running" mode: POSIX `execve`
 * only returns to the caller on failure (`ret == -1` and `errno` set — unlike
 * `posix_spawn`, which returns the errno directly; see
 * `libc/musl/src/process/execve.c`'s plain `syscall(SYS_execve, ...)`
 * wrapper, which follows the normal `errno`-setting convention), so a
 * surviving caller here IS the test: it prints "execve errno=<N>\n" (the
 * value of `errno` right after the failed call) and then `_exit(0)` — a
 * deliberately different, unambiguous status from the "returned but the
 * plain unconfigured path" RED-state `_exit(1)` below, so passing this exit
 * code alone already tells the caller-survived story. With `EXEC_TEST_PATH`
 * unset, this fixture keeps its original N1-I3c-Task-1 behavior
 * byte-for-byte.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    const char *test_path = getenv("EXEC_TEST_PATH");

    if (test_path != NULL) {
        char *argv[] = { (char *)test_path, (char *)0 };
        char *envp[] = { (char *)0 };
        execve(test_path, argv, envp);
        int saved_errno = errno;
        char line[48];
        int n = snprintf(line, sizeof(line), "execve errno=%d\n", saved_errno);
        if (n > 0) {
            write(1, line, (size_t)n);
        }
        _exit(0);
    }

    char *argv[] = { "/bin/exectarget", (char *)0 };
    char *envp[] = { (char *)0 };
    execve("/bin/exectarget", argv, envp);
    write(1, "execve returned\n", 16);
    _exit(1);
}
