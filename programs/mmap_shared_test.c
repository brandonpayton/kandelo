#define _GNU_SOURCE  /* for mremap / MREMAP_MAYMOVE */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>

int main(void) {
    const char *path = "/tmp/mmap_shared_test";

    // Create a file and extend to page size
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) { perror("open"); return 1; }

    long pagesize = sysconf(_SC_PAGESIZE);
    if (pagesize < 0) { perror("sysconf"); return 1; }
    printf("pagesize: %ld\n", pagesize);

    if (ftruncate(fd, pagesize) < 0) { perror("ftruncate"); return 1; }

    // mmap MAP_SHARED
    char *ptr = mmap(NULL, pagesize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (ptr == MAP_FAILED) { perror("mmap"); return 1; }
    printf("mmap ok at %p\n", ptr);

    // Write through the mapping
    ptr[0] = 'x';
    ptr[1] = 'y';
    ptr[2] = 'z';

    // msync to flush back to file
    if (msync(ptr, pagesize, MS_SYNC) < 0) { perror("msync"); return 1; }
    printf("msync ok\n");

    // Read from the fd to verify the data was written back
    lseek(fd, 0, SEEK_SET);
    char buf[4] = {0};
    if (read(fd, buf, 3) != 3) { perror("read"); return 1; }

    if (buf[0] != 'x' || buf[1] != 'y' || buf[2] != 'z') {
        fprintf(stderr, "msync writeback failed: got '%c%c%c'\n", buf[0], buf[1], buf[2]);
        return 1;
    }
    printf("read back: %c%c%c\n", buf[0], buf[1], buf[2]);

    // Also test: write more data and verify munmap flushes it back to
    // the file. Some linkers write their output via MAP_SHARED and rely
    // on munmap for final writeback.
    ptr[3] = 'w';
    if (munmap(ptr, pagesize) < 0) { perror("munmap"); return 1; }

    lseek(fd, 0, SEEK_SET);
    char munmap_buf[5] = {0};
    if (read(fd, munmap_buf, 4) != 4) { perror("read after munmap"); return 1; }
    if (memcmp(munmap_buf, "xyzw", 4) != 0) {
        fprintf(stderr, "munmap writeback failed: got '%c%c%c%c'\n",
                munmap_buf[0], munmap_buf[1], munmap_buf[2], munmap_buf[3]);
        return 1;
    }
    printf("read after munmap: %c%c%c%c\n",
           munmap_buf[0], munmap_buf[1], munmap_buf[2], munmap_buf[3]);

    close(fd);
    unlink(path);

    /* H1: a whole-page MAP_SHARED of a short file must never grow the file.
     * The tmpfs file is 100 bytes but the mapping covers a full page; writing
     * within EOF must persist, a write past EOF must be dropped, and the file
     * size must stay 100. Regression for the fd-writeback bridge growing the
     * file to the full mapping length. */
    {
        const char *h1 = "/tmp/mmap_shared_h1";
        int fd1 = open(h1, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd1 < 0) { perror("H1 open"); return 1; }
        if (ftruncate(fd1, 100) < 0) { perror("H1 ftruncate"); return 1; }
        char *m1 = mmap(NULL, pagesize, PROT_READ | PROT_WRITE, MAP_SHARED,
                        fd1, 0);
        if (m1 == MAP_FAILED) { perror("H1 mmap"); return 1; }
        m1[0] = 'A';    /* within EOF: must persist */
        m1[500] = 'B';  /* past EOF: must be dropped, must not grow the file */
        if (msync(m1, pagesize, MS_SYNC) < 0) { perror("H1 msync"); return 1; }
        struct stat st;
        if (fstat(fd1, &st) < 0) { perror("H1 fstat"); return 1; }
        if (st.st_size != 100) {
            fprintf(stderr, "H1 file grew to %lld (expected 100)\n",
                    (long long)st.st_size);
            return 1;
        }
        lseek(fd1, 0, SEEK_SET);
        char h1b = 0;
        if (read(fd1, &h1b, 1) != 1 || h1b != 'A') {
            fprintf(stderr, "H1 in-EOF write not persisted\n");
            return 1;
        }
        munmap(m1, pagesize);
        close(fd1);
        unlink(h1);
        printf("H1 no-grow ok\n");
    }

    /* M2: writeback must survive close(fd) after mmap. POSIX keeps the mapping
     * valid after the descriptor is closed. Regression for storing the guest
     * fd number (which becomes EBADF on close) instead of a stable dup. */
    {
        const char *m2p = "/tmp/mmap_shared_m2";
        int fd2 = open(m2p, O_CREAT | O_RDWR | O_TRUNC, 0644);
        if (fd2 < 0) { perror("M2 open"); return 1; }
        if (ftruncate(fd2, pagesize) < 0) { perror("M2 ftruncate"); return 1; }
        char *m2 = mmap(NULL, pagesize, PROT_READ | PROT_WRITE, MAP_SHARED,
                        fd2, 0);
        if (m2 == MAP_FAILED) { perror("M2 mmap"); return 1; }
        close(fd2);            /* legal: the mapping stays valid */
        m2[0] = 'Q';
        m2[1] = 'Z';
        if (msync(m2, pagesize, MS_SYNC) < 0) { perror("M2 msync"); return 1; }
        munmap(m2, pagesize);
        int rfd = open(m2p, O_RDONLY);
        if (rfd < 0) { perror("M2 reopen"); return 1; }
        char m2b[2] = {0};
        if (read(rfd, m2b, 2) != 2 || m2b[0] != 'Q' || m2b[1] != 'Z') {
            fprintf(stderr, "M2 writeback lost after close(fd): '%c%c'\n",
                    m2b[0], m2b[1]);
            return 1;
        }
        close(rfd);
        unlink(m2p);
        printf("M2 close-survives ok\n");
    }

    /* mremap MREMAP_MAYMOVE preserves prefix bytes.
     * Regression for host/src/kernel-worker.ts SYS_MREMAP post-syscall fixup.
     * Without it, a moving mremap above MMAP_THRESHOLD returns a zero-filled
     * new region and every mallocng realloc above ~128 KB loses its prefix. */
    {
        const size_t OLD_SIZE = 256 * 1024;
        const size_t NEW_SIZE = 512 * 1024;
        const size_t BLOCKER_SIZE = 64 * 1024;
        unsigned char *src = mmap(NULL, OLD_SIZE, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (src == MAP_FAILED) { perror("mremap-test: mmap src"); return 1; }
        /* MAP_FIXED blocker right after src forces the kernel to move on grow. */
        void *blocker = mmap(src + OLD_SIZE, BLOCKER_SIZE,
                             PROT_READ | PROT_WRITE,
                             MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
        if (blocker == MAP_FAILED) { perror("mremap-test: mmap blocker"); return 1; }
        for (size_t i = 0; i < OLD_SIZE; i++)
            src[i] = (unsigned char)((i * 0xAB) & 0xFF);
        void *moved = mremap(src, OLD_SIZE, NEW_SIZE, MREMAP_MAYMOVE);
        if (moved == MAP_FAILED) { perror("mremap-test: mremap"); return 1; }
        if (moved == src) {
            fprintf(stderr, "mremap-test: did not move despite blocker\n");
            return 1;
        }
        unsigned char *dst = moved;
        for (size_t i = 0; i < OLD_SIZE; i++) {
            unsigned char expected = (unsigned char)((i * 0xAB) & 0xFF);
            if (dst[i] != expected) {
                fprintf(stderr, "mremap-test: byte %zu: expected %02x got %02x\n",
                        i, expected, dst[i]);
                return 1;
            }
        }
        munmap(dst, NEW_SIZE);
        munmap(blocker, BLOCKER_SIZE);
        printf("mremap ok\n");
    }

    printf("PASS\n");
    return 0;
}
