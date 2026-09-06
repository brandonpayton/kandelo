/**
 * Freezing a process that is parked inside a blocking syscall.
 *
 * A process reaches the checkpoint hook after a syscall completes. One parked
 * in an indefinite `read` completes nothing, so the freeze can only reach it
 * by completing the call with `EINTR`. Nothing was caught, so the guest is
 * owed its read rather than an interruption, and the host publishes
 * `CHECKPOINT_REQUEST_RESTART` next to `CHECKPOINT_REQUEST_UNWIND` to say so.
 *
 * The fixture reports each read failure as its own errno next to whether a
 * signal was behind it, so a leaked interruption is `ERR:4:0` and a genuine
 * caught signal is `ERR:4:1`. A failure with any other errno names that
 * errno rather than being counted as an interruption.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const SIGUSR1 = 10;
/** The fixture's report for a read that ended with EINTR and no signal. */
const LEAKED_INTERRUPTION = "ERR:4:0";

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function startParkedGuest(): Promise<{
  host: NodeKernelHost;
  pid: number;
  output: () => string;
}> {
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    onPtyOutput: (_pid, data) => {
      output += new TextDecoder().decode(data);
    },
  });
  await host.init();
  let pid = 0;
  await new Promise<void>((resolve) => {
    void host.spawn(
      programBytes("checkpoint-blocking-read.wasm"),
      ["checkpoint-blocking-read"],
      {
        pty: true,
        onStarted: (startedPid) => {
          pid = startedPid;
          resolve();
        },
      },
    );
  });
  await expect
    .poll(() => output.includes("READY"), { timeout: 30_000 })
    .toBe(true);
  // One round trip before the freeze, so the process is provably parked in
  // the read rather than still reaching main.
  host.ptyWrite(pid, new TextEncoder().encode("a\n"));
  await expect
    .poll(() => output.includes("GOT:a"), { timeout: 30_000 })
    .toBe(true);
  return { host, pid, output: () => output };
}

describe("checkpoint of a process parked in a blocking syscall", () => {
  it(
    "captures it, and the read it was making resumes",
    { timeout: 120_000 },
    async () => {
      const { host, pid, output } = await startParkedGuest();
      try {
        const response = await host.captureCheckpointBytes(TIMEOUTS);

        // Without the restart bit the freeze has no boundary to reach and
        // ends in "a process did not reach UNWINDING".
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }

        // The freeze completed the parked read with EINTR to reach the hook.
        // The guest must never see that: no signal was caught, so an EINTR
        // here would be the platform surfacing its own bookkeeping.
        expect(output()).not.toContain(LEAKED_INTERRUPTION);

        // The resubmitted read is a real read, not a stub that returns to the
        // loop: a byte written after the freeze still arrives.
        host.ptyWrite(pid, new TextEncoder().encode("b\n"));
        await expect
          .poll(() => output().includes("GOT:b"), { timeout: 30_000 })
          .toBe(true);
        expect(output()).not.toContain(LEAKED_INTERRUPTION);
      } finally {
        await host.destroy();
      }
    },
  );

  it(
    "still ends the read when a caught signal interrupts it",
    { timeout: 120_000 },
    async () => {
      const { host, pid, output } = await startParkedGuest();
      try {
        // The guest catches SIGUSR1 without SA_RESTART. POSIX ends the read,
        // and the restart bit must not override that: the handler ran, so
        // this interruption is the guest's own business.
        expect(await host.signalProcess(pid, SIGUSR1)).toBe(true);
        await expect
          .poll(() => output().includes("ERR:4:1"), { timeout: 30_000 })
          .toBe(true);
        expect(output()).not.toContain(LEAKED_INTERRUPTION);

        // The loop parked again, so the machine is still freezable.
        const response = await host.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
      } finally {
        await host.destroy();
      }
    },
  );
});
