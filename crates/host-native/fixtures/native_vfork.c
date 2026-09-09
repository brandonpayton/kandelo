/*
 * Real vfork (N1 residual): the vfork analogue of `native_fork.c`
 * (`smoke_fork_parent_child`'s fixture). `vfork()`, like `fork()`, goes
 * through the guest's `kernel.kernel_fork(mode)` import DIRECTLY
 * (`libc/glue/channel_syscall.c:594-600`), never the generic syscall
 * dispatcher, using `WASM_POSIX_FORK_MODE_VFORK` instead of `_FORK`.
 *
 * `shared_marker` is the load-bearing proof this fixture exists for: it is
 * written by the CHILD, after `vfork()`, and read by the PARENT, after
 * `vfork()` returns to it. Real POSIX vfork semantics say the child
 * BORROWS the parent's own address space (no copy), so this write must be
 * visible to the parent. An ordinary COW `fork()` — or a `vfork()`
 * implemented as a plain COW fork, which is what this host did before the
 * real-vfork fix this fixture exercises — gives the child a PRIVATE memory
 * copy instead: the parent would then see `shared_marker`'s original value
 * (`0`), not the child's `99`, and this fixture would exit `21` rather than
 * `3`. This is a stronger proof than ordering alone: it is causally
 * impossible for the parent to observe `99` unless the write happened in
 * memory the parent itself later reads — no separate "was the parent
 * actually suspended" check is needed, because a non-suspended (merely
 * concurrent) parent racing a COW child could never see the child's write
 * either way (different backing stores entirely).
 *
 * `marker` (like `native_fork.c`'s own `marker`) is a genuinely live local
 * declared before `vfork()` and read after it in both branches, proving the
 * borrowed child's own replayed frame preserved it correctly too.
 */
#include <sys/wait.h>
#include <unistd.h>

volatile int shared_marker = 0;

int main(void) {
    volatile int marker = 42;
    pid_t p = vfork();
    if (p == 0) {
        shared_marker = 99;
        write(1, "child\n", 6);
        _exit(marker == 42 ? 3 : 9);
    } else {
        int st;
        waitpid(p, &st, 0);
        write(1, "parent\n", 7);
        if (shared_marker != 99) {
            // The child's write never became visible to the parent: this is
            // NOT real vfork (either the memory was cloned, not shared, or
            // the parent resumed before the child ran at all).
            _exit(21);
        }
        _exit(marker == 42 ? WEXITSTATUS(st) : 9);
    }
}
