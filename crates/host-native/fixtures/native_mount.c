/*
 * Explicit native-directory mount guest for the native Wasmtime host's
 * N1-I1b test (`smoke_runs_native_dir_mount`, see `../src/guest.rs`).
 *
 * Reads `/host/greeting.txt` — a path under a top-level mount point that is
 * NOT owned by the in-kernel rootfs overlay (a registered foreign prefix) —
 * and echoes its contents to stdout. This proves the whole mount mechanism:
 * `kernel_rootfs_set_foreign_prefixes` makes the overlay disown `/host`, so
 * the kernel's path resolution falls through to `host_open`/`host_pread`/
 * `host_close` on the native host's mount-aware `HostFs`, which strips the
 * `/host` prefix and reads the real file from the mounted host directory.
 *
 * Built through the SDK like the other fixtures; see fixtures/README.md.
 */
#include <fcntl.h>
#include <unistd.h>

int main(void) {
    int fd = open("/host/greeting.txt", O_RDONLY);
    if (fd < 0) {
        return 10;
    }
    char buf[256];
    ssize_t total = 0;
    for (;;) {
        ssize_t got = read(fd, buf + total, sizeof(buf) - (size_t)total);
        if (got < 0) {
            close(fd);
            return 11;
        }
        if (got == 0) {
            break;
        }
        total += got;
    }
    close(fd);
    if (total > 0) {
        write(1, buf, (size_t)total);
    }
    return 0;
}
