// P-11 — root and later linked-fork continuation allocations that exhaust
// process address space must return ENOMEM without creating a child or
// poisoning the still-running parent.

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

#define WASM_PAGE_BYTES (64u * 1024u)
#define MAX_FILLER_MAPPINGS 512

static void *filler_mappings[MAX_FILLER_MAPPINGS];

__attribute__((noinline))
static pid_t fork_at_depth(int depth) {
    if (depth == 0) return fork();

    pid_t result = fork_at_depth(depth - 1);
    // WHY: keep each recursive activation live across fork so instrumentation
    // must save enough frames to request a second continuation chunk.
    __asm__ volatile("" : "+r"(depth));
    return result + (depth == -1);
}

static int release_fillers(size_t count) {
    int failed = 0;
    for (size_t i = 0; i < count; i++) {
        if (munmap(filler_mappings[i], WASM_PAGE_BYTES) != 0) failed = 1;
    }
    return failed;
}

static int emit_marker(const char *text, size_t length) {
    while (length > 0) {
        const ssize_t written = write(STDOUT_FILENO, text, length);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return -1;
        text += (size_t)written;
        length -= (size_t)written;
    }
    return 0;
}

static int prove_parent_syscalls_remain_usable(void) {
    int pipefd[2];
    char sent = 'K';
    char received = '\0';

    if (pipe(pipefd) != 0) return -1;
    if (write(pipefd[1], &sent, 1) != 1 || read(pipefd[0], &received, 1) != 1) {
        const int saved_errno = errno;
        close(pipefd[0]);
        close(pipefd[1]);
        errno = saved_errno;
        return -1;
    }
    const int read_close_result = close(pipefd[0]);
    const int read_close_errno = errno;
    const int write_close_result = close(pipefd[1]);
    if (read_close_result != 0) {
        errno = read_close_errno;
        return -1;
    }
    if (write_close_result != 0) {
        return -1;
    }
    if (received != sent) {
        errno = EIO;
        return -1;
    }
    return 0;
}

int main(void) {
    const pid_t original_pid = getpid();
    size_t filler_count = 0;

    while (filler_count < MAX_FILLER_MAPPINGS) {
        void *mapping = mmap(
            NULL,
            WASM_PAGE_BYTES,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1,
            0
        );
        if (mapping == MAP_FAILED) break;
        filler_mappings[filler_count++] = mapping;
    }

    if (filler_count == MAX_FILLER_MAPPINGS || errno != ENOMEM) {
        printf(
            "FAIL: address-space fill count=%zu errno=%d\n",
            filler_count,
            errno
        );
        release_fillers(filler_count);
        return 1;
    }
    if (filler_count < 2) {
        printf("FAIL: fewer than two filler mappings were available\n");
        return 1;
    }

    // WHY: leave the address space completely full for this first fork. Its
    // initial 64-KiB continuation mmap must fail before unwind starts, proving
    // the real worker-side root-allocation error path rather than only the
    // host arena unit.
    errno = 0;
    const pid_t root_failed_child = fork();
    const int root_fork_errno = errno;
    if (root_failed_child != -1 || root_fork_errno != ENOMEM) {
        printf(
            "FAIL: root-allocation fork result=%d errno=%d\n",
            (int)root_failed_child,
            root_fork_errno
        );
        release_fillers(filler_count);
        return 1;
    }
    if (getpid() != original_pid) {
        printf("FAIL: process identity changed after root-allocation failure\n");
        release_fillers(filler_count);
        return 1;
    }
    static const char root_enomem_marker[] = "ROOT_CONTINUATION_ENOMEM: ok\n";
    if (emit_marker(root_enomem_marker, sizeof(root_enomem_marker) - 1) != 0) {
        release_fillers(filler_count);
        return 1;
    }

    int status = 0;
    errno = 0;
    const pid_t root_phantom = waitpid(-1, &status, WNOHANG);
    if (root_phantom != -1 || errno != ECHILD) {
        printf(
            "FAIL: root-allocation failure left child=%d errno=%d\n",
            (int)root_phantom,
            errno
        );
        release_fillers(filler_count);
        return 1;
    }
    static const char no_phantom_marker[] = "ROOT_NO_PHANTOM_CHILD: ok\n";
    if (emit_marker(no_phantom_marker, sizeof(no_phantom_marker) - 1) != 0) {
        release_fillers(filler_count);
        return 1;
    }

    if (prove_parent_syscalls_remain_usable() != 0 || getpid() != original_pid) {
        printf("FAIL: parent unusable after root-allocation failure errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    static const char usable_marker[] = "ROOT_PARENT_USABLE: ok\n";
    if (emit_marker(usable_marker, sizeof(usable_marker) - 1) != 0) {
        release_fillers(filler_count);
        return 1;
    }

    // WHY: a successful module-backed fork transaction needs three distinct
    // pages — the process/module metadata arena, one continuation frame chunk,
    // and the serialized replay-journal image — so freeing exactly three lets
    // the later recovery fork complete while still being tight. The 4,096-deep
    // call chain, however, needs far more frame chunks than three pages hold, so
    // its continuation allocation fails AFTER frames have committed (its second
    // chunk fills and the next mmap is refused), exercising the mid-unwind
    // ABORT_UNWINDING path rather than the simpler root-allocation error path.
    for (int i = 0; i < 3; i++) {
        filler_count--;
        if (munmap(filler_mappings[filler_count], WASM_PAGE_BYTES) != 0) {
            printf(
                "FAIL: could not make fork transaction page available errno=%d\n",
                errno
            );
            release_fillers(filler_count);
            return 1;
        }
    }

    errno = 0;
    const pid_t failed_child = fork_at_depth(4096);
    const int fork_errno = errno;
    if (failed_child != -1 || fork_errno != ENOMEM) {
        printf(
            "FAIL: deep fork result=%d errno=%d\n",
            (int)failed_child,
            fork_errno
        );
        release_fillers(filler_count);
        return 1;
    }
    if (getpid() != original_pid) {
        printf("FAIL: process identity changed after failed fork\n");
        release_fillers(filler_count);
        return 1;
    }
    printf("CONTINUATION_ENOMEM: ok\n");

    status = 0;
    errno = 0;
    const pid_t phantom = waitpid(-1, &status, WNOHANG);
    if (phantom != -1 || errno != ECHILD) {
        printf("FAIL: failed fork left child=%d errno=%d\n", (int)phantom, errno);
        release_fillers(filler_count);
        return 1;
    }
    printf("NO_PHANTOM_CHILD: ok\n");

    // Abort replay must unmap the metadata arena, the continuation root, and the
    // partial linked chain. Hold three probe mappings concurrently to prove all
    // three pages the aborted transaction touched are reusable before relying on
    // them for the recovery fork.
    void *probes[3] = {MAP_FAILED, MAP_FAILED, MAP_FAILED};
    for (int i = 0; i < 3; i++) {
        probes[i] = mmap(
            NULL,
            WASM_PAGE_BYTES,
            PROT_READ | PROT_WRITE,
            MAP_PRIVATE | MAP_ANONYMOUS,
            -1,
            0
        );
        if (probes[i] == MAP_FAILED) {
            printf("FAIL: fork transaction allocation leaked errno=%d\n", errno);
            for (int j = 0; j < i; j++) {
                munmap(probes[j], WASM_PAGE_BYTES);
            }
            release_fillers(filler_count);
            return 1;
        }
    }
    for (int i = 0; i < 3; i++) {
        if (munmap(probes[i], WASM_PAGE_BYTES) != 0) {
            printf("FAIL: probe cleanup errno=%d\n", errno);
            release_fillers(filler_count);
            return 1;
        }
    }
    printf("CONTINUATION_PAGE_REUSED: ok\n");

    const pid_t recovery_child = fork();
    if (recovery_child < 0) {
        printf("FAIL: recovery fork errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    if (recovery_child == 0) {
        if (getppid() != original_pid) _exit(2);
        printf("RECOVERY_CHILD: ok\n");
        fflush(stdout);
        _exit(0);
    }
    if (waitpid(recovery_child, &status, 0) != recovery_child) {
        printf("FAIL: recovery waitpid errno=%d\n", errno);
        release_fillers(filler_count);
        return 1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        printf("FAIL: recovery child status=%d\n", status);
        release_fillers(filler_count);
        return 1;
    }
    if (getpid() != original_pid) {
        printf("FAIL: parent identity changed after recovery fork\n");
        release_fillers(filler_count);
        return 1;
    }
    printf("RECOVERY_PARENT: child=%d\n", (int)recovery_child);

    if (release_fillers(filler_count)) {
        printf("FAIL: filler cleanup errno=%d\n", errno);
        return 1;
    }
    printf("PASS: P-11\n");
    return 0;
}
