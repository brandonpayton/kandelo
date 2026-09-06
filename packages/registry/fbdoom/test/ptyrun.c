/* Run a program with a PTY slave on stdin, stdout, and stderr.
 *
 * fbDOOM scans its own descriptors for a terminal and exits when it finds
 * none ("Unable to find a file descriptor associated with the keyboard").
 * The fps harness needs it to keep running, so give it a real terminal.
 *
 * `-l <path>` also writes the drained terminal stream to a file. The harness
 * captures the guest's stdout but only surfaces it when the program exits, so
 * a program that stalls reports nothing. The log is readable while it runs.
 *
 * Usage: ptyrun [-l <path>] <program> [args...]
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    int log = -1;
    if (argc >= 3 && strcmp(argv[1], "-l") == 0) {
        log = open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (log < 0) {
            perror(argv[2]);
            return 1;
        }
        argv += 2;
        argc -= 2;
    }

    if (argc < 2) {
        fprintf(stderr, "usage: ptyrun [-l <path>] <program> [args...]\n");
        return 2;
    }

    int master = posix_openpt(O_RDWR | O_NOCTTY);
    if (master < 0) {
        perror("posix_openpt");
        return 1;
    }
    if (grantpt(master) != 0) {
        perror("grantpt");
        return 1;
    }
    if (unlockpt(master) != 0) {
        perror("unlockpt");
        return 1;
    }

    const char *slave_path = ptsname(master);
    if (slave_path == NULL) {
        perror("ptsname");
        return 1;
    }

    pid_t child = fork();
    if (child < 0) {
        perror("fork");
        return 1;
    }

    if (child == 0) {
        int diagnostics = dup(2);
        int slave = open(slave_path, O_RDWR);
        if (slave < 0) {
            dprintf(diagnostics, "open %s: %s\n", slave_path, strerror(errno));
            _exit(1);
        }
        close(master);
        dup2(slave, 0);
        dup2(slave, 1);
        dup2(slave, 2);
        if (slave > 2) close(slave);
        execv(argv[1], &argv[1]);
        dprintf(diagnostics, "execv %s: %s\n", argv[1], strerror(errno));
        _exit(127);
    }

    /* Drain the master so the child never blocks on a full terminal buffer. */
    char buffer[4096];
    for (;;) {
        ssize_t got = read(master, buffer, sizeof(buffer));
        if (got > 0) {
            if (log >= 0) write(log, buffer, (size_t)got);
            ssize_t written = 0;
            while (written < got) {
                ssize_t step = write(1, buffer + written, (size_t)(got - written));
                if (step <= 0) break;
                written += step;
            }
            continue;
        }
        if (got < 0 && errno == EINTR) continue;
        break;
    }

    int status = 0;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
