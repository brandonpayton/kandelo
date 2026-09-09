/*
 * N1-I3d Task 1: the `execveat` (dirfd-relative exec, `SYS_EXECVEAT` = 386)
 * happy-path probe. musl does not expose a plain `execveat()` libc wrapper —
 * only `fexecve()` (`libc/musl/src/process/fexecve.c`), which calls the SAME
 * syscall with a bare fd + `AT_EMPTY_PATH` — so this fixture invokes the raw
 * syscall directly via `syscall(SYS_execveat, ...)`, exactly the pattern
 * `fexecve.c` itself uses.
 *
 * Reuses I3c's `/bin/exectarget` image (writes "exec ok\n", `_exit(9)`) as
 * the exec target, resolved `AT_FDCWD`-relative with a plain absolute path
 * (dirfd ignored by the kernel for an absolute path) and `flags=0` — the
 * ordinary `execveat(AT_FDCWD, path, argv, envp, 0)` case glibc's own
 * `execveat()` wrapper boils down to. Per POSIX, a successful `execveat`
 * never returns to the caller. If it DOES return (today's RED state:
 * `SYS_EXECVEAT` falls through to the kernel's generic dispatch, which has
 * no handler for it and returns `-ENOSYS`), this prints a line that must
 * NEVER appear once `execveat` actually works, then exits 1 (a status the
 * exec'd target never uses, so the host test can tell the two outcomes
 * apart even without the stdout check).
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(void) {
    char *argv[] = { "/bin/exectarget", (char *)0 };
    char *envp[] = { (char *)0 };
    syscall(SYS_execveat, AT_FDCWD, "/bin/exectarget", argv, envp, 0);
    write(1, "execveat returned\n", 19);
    _exit(1);
}
