/*
 * Trivial guest program for the native Wasmtime host's increment-2 smoke test.
 *
 * It exercises the minimal boot + syscall path a real Kandelo process runs
 * through the record/raw channel, with no VFS and no fork:
 *
 *   - getpid()  — a scalar-only syscall (no host capability, no pointer args);
 *                 proves the channel round-trips a return value.
 *   - write(1, ...) — a RAW syscall with an inbound pointer buffer; proves the
 *                 host copies the buffer into kernel scratch, rewrites arg1 to
 *                 the scratch address, and routes fd 1 to host stdout.
 *   - return 0  — main returns, libc calls the exit path, and the native host
 *                 collects the exit status.
 *
 * The exit code is 0 only if getpid() returned a plausible pid, so a green
 * test proves the scalar syscall really ran (not just that the program exited).
 *
 * Built through the SDK exactly like scripts/build-programs.sh builds the
 * example C programs (same CFLAGS, glue, crt1.o, libc.a). A non-forking
 * standalone program needs no fork instrumentation, so the raw linker output is
 * the committed fixture. See crates/host-native/fixtures/README.md for the
 * build command that regenerates native_hello.wasm.
 */
#include <unistd.h>

int main(void) {
    static const char msg[] = "hello from the native wasmtime host\n";
    pid_t pid = getpid();
    write(1, msg, sizeof(msg) - 1);
    return pid > 0 ? 0 : 1;
}
