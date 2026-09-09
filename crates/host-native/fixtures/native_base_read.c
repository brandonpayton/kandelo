/*
 * Base-image read guest for the native Wasmtime host's N1-I2 test
 * (`smoke_reads_base_file`, see `../src/guest.rs` / `../src/lib.rs`).
 *
 * Unlike `native_vfs.c` (which only ever creates overlay-local files with no
 * manifest loaded), this fixture opens a path that exists ONLY because the
 * test's `BaseImage` manifest was loaded into the rootfs overlay before
 * dispatch: `/etc/hello`, a `BaseRegular` entry whose bytes are served
 * through the native `host_blob_read` import (wired in Task 1, reachable for
 * the first time via Task 2's boot-time manifest load). Without that load,
 * `/etc/hello` does not exist in the empty overlay and `open` returns ENOENT.
 *
 * open(O_RDONLY) + read + write the contents to stdout + exit 0.
 */
#include <fcntl.h>
#include <unistd.h>

int main(void) {
    int fd = open("/etc/hello", O_RDONLY);
    if (fd < 0) {
        return 10;
    }
    char buf[64];
    ssize_t n = read(fd, buf, sizeof(buf));
    close(fd);
    if (n <= 0) {
        return 11;
    }
    write(1, buf, (size_t)n);
    return 0;
}
