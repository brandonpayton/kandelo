/*
 * Record-path guest for the native Wasmtime host's increment-3 smoke test.
 *
 * It exercises the Phase 2 opaque-record transport end-to-end on a non-JS
 * engine: uname(2) is a non-RAW syscall, so the flipped libc glue self-marshals
 * the struct-utsname pointer into an opaque record in the channel data region
 * and sets REQUEST_FLAG_OPAQUE_RECORD. The native host must blind-transport that
 * record to the kernel, let the kernel decode it and write the struct back into
 * the record's Out span, then blind-copy the data region back so the guest's
 * __unmarshal_channel_record delivers the struct to &u on the stack.
 *
 * If any link in that chain is wrong, u.sysname is empty or garbage and the
 * printed line does not match the kernel's compiled-in "wasm-posix". So a green
 * test proves the whole opaque-record round-trip, not just that uname returned.
 *
 * Built through the SDK like the example C programs; see fixtures/README.md.
 */
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void) {
    struct utsname u;
    if (uname(&u) != 0) {
        return 2;
    }
    char line[128];
    size_t n = strlen(u.sysname);
    if (n + 1 > sizeof(line)) {
        return 3;
    }
    memcpy(line, u.sysname, n);
    line[n] = '\n';
    write(1, line, n + 1);
    return 0;
}
