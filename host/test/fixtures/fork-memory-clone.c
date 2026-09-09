// Fork memory-clone fixture (dynamic mmap frame allocation model).
//
// Verifies the process-memory clone invariant: a fork child inherits a COW copy
// of the parent's grown memory, sees its live boundary bytes intact, and its
// private writes stay isolated from the parent.
//
// The parent grows its memory the REAL way a ported program does: a tracked
// `mmap(NULL, ...)` routes through the kernel's `SYS_mmap` -> `find_gap`, so the
// region is a KERNEL-TRACKED mapping. Under the module-owned growing frame
// allocator (dynamic channel `SYS_mmap`), the fork-time continuation frames are
// placed by `find_gap` in genuinely-free space ABOVE this tracked region, so
// they never clobber the live boundary byte.
//
// This fixture makes NO strict absolute page-count assertion: a real program's
// memory legitimately grows to hold fork-continuation frames, and the growable
// allocator is uncapped. The correct behavior is child survival + boundary-byte
// preservation + snapshot isolation, not a fixed `original + N` page total (the
// old `__builtin_wasm_memory_grow`-based `+3` assertion was a fixture artifact
// of UNtracked growth, which `find_gap` could not see and would overwrite).

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define WASM_PAGE_SIZE 65536u
// A multi-page tracked region grown after the initial image, big enough that its
// boundary byte sits well past main's starting break.
#define GROW_BYTES (4u * WASM_PAGE_SIZE)

int main(void)
{
    // Grow via a kernel-tracked mmap (find_gap places fork frames above it).
    volatile uint8_t *region = mmap(
        NULL,
        GROW_BYTES,
        PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS,
        -1,
        0
    );
    if (region == MAP_FAILED) {
        fprintf(stderr, "mmap failed: %s\n", strerror(errno));
        return 1;
    }

    // Fault every page and stamp the boundary byte of the tracked region.
    for (size_t i = 0; i < GROW_BYTES; i += WASM_PAGE_SIZE) {
        region[i] = 0xa5;
    }
    volatile uint8_t *last_byte = &region[GROW_BYTES - 1];
    *last_byte = 0xa5;

    pid_t child = fork();
    if (child < 0) {
        fprintf(stderr, "fork failed: %s\n", strerror(errno));
        return 2;
    }
    if (child == 0) {
        // The child inherits a COW copy. Its grown region and the boundary byte
        // must have survived fork-frame placement (no clobber).
        if (*last_byte != 0xa5) {
            fprintf(stderr, "child lost grown-region boundary byte\n");
            _exit(4);
        }
        for (size_t i = 0; i < GROW_BYTES; i += WASM_PAGE_SIZE) {
            if (region[i] != 0xa5) {
                _exit(3);
            }
        }
        // The child must own an independent fork snapshot.
        *last_byte = 0x5a;
        _exit(0);
    }

    int status = 0;
    if (waitpid(child, &status, 0) != child) {
        fprintf(stderr, "waitpid failed: %s\n", strerror(errno));
        return 5;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child status=%d\n", status);
        return 6;
    }
    // Parent snapshot isolation: the child's private write is not visible.
    if (*last_byte != 0xa5) {
        fprintf(stderr, "child did not preserve parent snapshot isolation\n");
        return 7;
    }

    printf(
        "FORK_MEMORY_CLONE_PASS pages=%zu boundary=%u\n",
        (size_t)__builtin_wasm_memory_size(0),
        (unsigned)*last_byte
    );
    return 0;
}
