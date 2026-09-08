// PROBE FIXTURE (Phase 0 growable-arena probe — NOT a production contract test).
//
// Purpose: settle whether the fix-y frame/guest-page collision is a FIXTURE
// artifact of `fork-memory-clone.c`'s raw `__builtin_wasm_memory_grow` (which
// the kernel MemoryManager never learns about, so `find_gap` places fork frames
// into the guest's grown-but-untracked live pages), or a REAL headroom/placement
// constraint. This program grows its heap the REAL way a ported C program does:
// a large `malloc` routes through mallocng to `mmap(0, ...)` -> `SYS_mmap` ->
// kernel `find_gap`, i.e. a KERNEL-TRACKED mapping. It then forks from a DEEP
// linked continuation so the fork-time frame capture is large (used to exceed
// the bounded 2 MiB Fix X arena when the growable channel path is enabled).
//
// Unlike fork-memory-clone.c, this fixture does NOT assert strict zero page
// growth — a real program never does; it only requires that fork not CLOBBER
// live data and that the child replay correctly. Growth to hold fork frames is
// acceptable for a real program; the strict "original+3" assertion was the
// fixture-specific artifact.

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define WASM_PAGE_SIZE 65536u

// >= mallocng's MMAP_THRESHOLD: a dedicated tracked mmap, not brk/raw grow.
#define BIG_ALLOC (6u * 1024u * 1024u) // 6 MiB

static unsigned char *g_buf;
static volatile unsigned g_sink;

// Deep recursion so fork() runs from a deep linked continuation. Each frame
// carries a little live state the child must observe intact after replay.
static int recurse_and_fork(unsigned depth, unsigned target)
{
    volatile unsigned char marker = (unsigned char)(depth & 0xff);
    if (depth < target) {
        int r = recurse_and_fork(depth + 1, target);
        g_sink += marker; // keep `marker` live across the recursive call
        return r;
    }

    pid_t child = fork();
    if (child < 0) {
        return -1;
    }
    if (child == 0) {
        // The child inherits a COW copy. Verify the tracked malloc'd region
        // survived fork-frame placement (no clobber), then prove independence.
        if (g_buf[0] != 0xa5 || g_buf[BIG_ALLOC - 1] != 0x5c) {
            _exit(3);
        }
        for (size_t i = 0; i < BIG_ALLOC; i += WASM_PAGE_SIZE) {
            if (g_buf[i] != 0xa5) {
                _exit(4);
            }
        }
        if (marker != (unsigned char)(target & 0xff)) {
            _exit(5);
        }
        g_buf[BIG_ALLOC - 1] = 0x11; // private write (isolation check in parent)
        _exit(0);
    }

    int status = 0;
    if (waitpid(child, &status, 0) != child) {
        return -2;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child status=%d\n", status);
        return -3;
    }
    return 0;
}

int main(int argc, char **argv)
{
    unsigned target = 2000;
    if (argc > 1) {
        target = (unsigned)strtoul(argv[1], NULL, 10);
    }

    g_buf = malloc(BIG_ALLOC);
    if (!g_buf) {
        perror("malloc");
        return 1;
    }
    memset(g_buf, 0xa5, BIG_ALLOC);
    g_buf[BIG_ALLOC - 1] = 0x5c;
    // Fault every page so the tracked region is genuinely live before the fork.
    for (size_t i = 0; i < BIG_ALLOC; i += WASM_PAGE_SIZE) {
        g_sink += g_buf[i];
    }

    int rc = recurse_and_fork(0, target);
    if (rc != 0) {
        fprintf(stderr, "recurse_and_fork rc=%d\n", rc);
        return 2;
    }

    // Parent snapshot isolation: the child's private write must not be visible.
    if (g_buf[BIG_ALLOC - 1] != 0x5c) {
        return 7;
    }

    printf(
        "MALLOC_DEEP_FORK_PASS target=%u pages=%zu\n",
        target,
        (size_t)__builtin_wasm_memory_size(0)
    );
    return 0;
}
