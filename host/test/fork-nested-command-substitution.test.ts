// Regression: real bash forks that make a COW child fork AGAIN must not trap.
//
// Nested command substitution `echo $(echo $(echo hi))` forks the outer
// substitution's subshell, which is a COW child, and that child then forks
// again for the inner substitution. Its second `fm_capture_begin` drops the
// capture `ReferenceGraphBuilder` the child inherited (through the guest memory
// clone) from the parent — a builder whose module bump-heap backing the child's
// own reconstruction has since reset and overwritten. The pre-fix module walked
// that clobbered `BTreeMap` on drop and trapped `unreachable`, surfacing as the
// masked `__wpk_fork_unwind_transport_direct_0` "unreachable" that killed the
// worker. See the co-resident fork-module COW-inheritance reset fix.
//
// This drives a real bash + coreutils through `NodeKernelHost`, the same path a
// production worker uses. It traps (empty output / worker death) on the pre-fix
// module and prints `hi` after the fix. Skipped when the source-only bash /
// coreutils artifacts are not staged (they are build outputs, not committed).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";

const ROOT =
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT ??
  resolve(__dirname, "../../local-binaries/source-only-v1");
const BASH = resolve(ROOT, "programs/wasm32/bash.wasm");
const COREUTILS = resolve(ROOT, "programs/wasm32/coreutils.wasm");

const haveBinaries = existsSync(BASH) && existsSync(COREUTILS);

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runBash(script: string): Promise<{ code: number; out: string }> {
  const execPrograms: Record<string, string> = {};
  for (const n of ["cat", "echo", "true", "false", "seq"]) {
    execPrograms[`/bin/${n}`] = COREUTILS;
    execPrograms[`/usr/bin/${n}`] = COREUTILS;
  }
  execPrograms["/bin/bash"] = BASH;
  execPrograms["/bin/sh"] = BASH;
  let out = "";
  const host = new NodeKernelHost({
    maxWorkers: 8,
    execPrograms,
    onStdout: (_pid, data) => {
      out += Buffer.from(data).toString("utf8");
    },
    onStderr: () => {},
  });
  await host.init();
  try {
    const code = await host.spawn(loadBytes(BASH), ["bash", "-c", script], {
      env: ["HOME=/tmp", "PATH=/usr/bin:/bin", "TMPDIR=/tmp", "TERM=dumb"],
      cwd: "/",
    });
    return { code, out };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe.skipIf(!haveBinaries)(
  "fork: nested command substitution (COW child forks again)",
  () => {
    it("forks a re-forking COW child without trapping the capture path", async () => {
      const { code, out } = await runBash("echo $(echo $(echo hi))");
      expect(out).toContain("hi");
      expect(code).toBe(0);
    }, 60_000);

    it("forks a loop of command substitutions", async () => {
      const { code, out } = await runBash(
        "for i in 1 2 3; do echo v$(echo $i); done",
      );
      expect(out).toContain("v1");
      expect(out).toContain("v2");
      expect(out).toContain("v3");
      expect(code).toBe(0);
    }, 60_000);
  },
);
