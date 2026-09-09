/*
 * Sandboxed in-memory VFS + argv guest for the native Wasmtime host's N1-I1a
 * test (`smoke_runs_inmemory_vfs`, see `../src/guest.rs`).
 *
 * This is the first fixture that exercises the platform's *default* native
 * filesystem: the in-kernel rootfs overlay (`/`) and tmpfs (`/tmp`), both
 * empty and writable, entirely in kernel memory — no host directory, no VFS
 * image manifest, no `host_open`. It proves:
 *
 *   - mkdir("/data")            — the overlay creates `/` lazily and accepts
 *                                 a new directory with no manifest loaded;
 *   - open(..., O_CREAT|O_RDWR) — the overlay stores the new file inline
 *                                 (never touches `host_blob_read`);
 *   - write + lseek + read      — round-trips through the overlay's own
 *                                 storage, not a host-backed file;
 *   - the same round-trip under `/tmp`  — the separate in-kernel tmpfs;
 *   - argc/argv[1]              — real launch metadata via `kernel_get_argc`
 *                                 / `kernel_argv_read`, not the historical
 *                                 argc==0 "a.out" fallback.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Create `path`, write `content`, seek back to the start, read it back, and
 * echo the round-tripped bytes plus a newline to stdout. Returns 0 on an
 * exact round-trip, a distinct negative code otherwise so a mismatch is
 * diagnosable from the exit status alone. */
static int roundtrip(const char *path, const char *content) {
    int fd = open(path, O_CREAT | O_RDWR, 0644);
    if (fd < 0) {
        return -1;
    }
    size_t len = strlen(content);
    ssize_t written = write(fd, content, len);
    if (written != (ssize_t)len) {
        close(fd);
        return -2;
    }
    if (lseek(fd, 0, SEEK_SET) != 0) {
        close(fd);
        return -3;
    }
    char buf[64];
    ssize_t got = read(fd, buf, sizeof(buf) - 1);
    close(fd);
    if (got != (ssize_t)len || memcmp(buf, content, len) != 0) {
        return -4;
    }
    buf[got] = '\0';
    write(1, buf, (size_t)got);
    write(1, "\n", 1);
    return 0;
}

int main(int argc, char **argv) {
    if (mkdir("/data", 0755) != 0) {
        return 10;
    }
    if (roundtrip("/data/f", "hello-data") != 0) {
        return 11;
    }
    if (roundtrip("/tmp/f", "hello-tmp") != 0) {
        return 12;
    }

    char argc_line[32];
    int n = snprintf(argc_line, sizeof(argc_line), "argc:%d\n", argc);
    if (n > 0) {
        write(1, argc_line, (size_t)n);
    }

    if (argc > 1) {
        write(1, argv[1], strlen(argv[1]));
        write(1, "\n", 1);
    }
    return 0;
}
