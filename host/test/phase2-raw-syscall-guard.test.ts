import { describe, expect, it } from "vitest";

import { HOST_RAW_SYSCALLS, RECORD_MAGIC } from "../src/generated/abi";
import { GENERIC_BLOCKING_SNAPSHOT_SYSCALLS } from "../src/kernel-worker";

/**
 * Phase 2 (Option A) safety net. The opaque-record fast-path in
 * `#handleSyscallInner` blind-transports any syscall whose channel data begins
 * with `RECORD_MAGIC`, bypassing the Tier-A intercept ladder and the whole
 * descriptor/blocking-retry machinery. A syscall that must NOT take that path —
 * every host-blocking-managed syscall — has to be in the RAW set so the guest
 * never marshals a record for it and the host guard can fail loud if one ever
 * arrives carrying a magic.
 *
 * A missing blocking entry deadlocks the host EAGAIN park/retry protocol, so
 * this cross-check pins the generated RAW set (single source of truth:
 * `wasm_posix_shared::host_raw_syscalls`) against the authoritative host
 * blocking-snapshot set.
 */
describe("Phase 2 RAW syscall guard", () => {
  it("covers every generic blocking-snapshot syscall", () => {
    const missing = [...GENERIC_BLOCKING_SNAPSHOT_SYSCALLS].filter(
      (nr) => !HOST_RAW_SYSCALLS.has(nr),
    );
    expect(
      missing,
      `blocking snapshot syscalls missing from HOST_RAW_SYSCALLS: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("exposes a non-zero record magic sentinel", () => {
    expect(RECORD_MAGIC).toBeGreaterThan(0);
    // "KCR1" little-endian.
    expect(RECORD_MAGIC).toBe(0x3152_434b);
  });

  it("keeps the RAW set sorted, unique, and non-empty", () => {
    const values = [...HOST_RAW_SYSCALLS];
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
  });
});
