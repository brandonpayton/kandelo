// Regression: a real bash pipeline forked inside command substitution must not
// trap the co-resident fork module's reference-graph decode or replay setup.
//
// `echo $(echo b | while read x; do echo $x; done)` forks the substitution's
// subshell (a COW child), which then forks the pipeline segments (further COW
// children). Each pipeline child inherits — through the guest memory clone —
// the parent's resident fork-module statics (`DECODED_GRAPH`, `REFERENCE_STATE`,
// `RECONSTRUCTION_STATE`, `REFERENCE_FEED`), each owning a
// `SegmentedReferenceTransaction`/replay feed whose `Vec`/`BTreeMap` interiors
// point into the parent's bump heap. By the time the child runs, the parent has
// reset and REUSED those bump addresses, so the inherited structures are
// clobbered. The pre-fix module cleared them with `*slot = None`, running `Drop`
// and walking clobbered `BTreeMap` child pointers: the host-side
// `fm_decode_reference_graph` decode dereferenced a garbage pointer out of guest
// memory ("memory access out of bounds"), and the later replay-setup reclaim in
// `fm_begin_reference_replay` trapped `unreachable` "before replay readiness".
// The fix clears these resident statics with `abandon_resident` (forget, no
// Drop walk); the types have no side-effecting Drop, so it is semantically
// identical and frees no real resource (the bump reclaims wholesale).
//
// The pipe segment uses only bash builtins (`while read`) so the test needs no
// external binary and exercises purely the fork/continuation path. This drives a
// real bash through `NodeKernelHost`, the production worker path. It traps
// (empty output / dead worker) on the pre-fix module and prints `b` after the
// fix. Skipped when the source-only bash artifact is not staged (a build output,
// not committed).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";

const ROOT =
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT ??
  resolve(__dirname, "../../local-binaries/source-only-v1");
const BASH = resolve(ROOT, "programs/wasm32/bash.wasm");

const haveBinaries = existsSync(BASH);

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runBash(script: string): Promise<{ code: number; out: string }> {
  let out = "";
  const host = new NodeKernelHost({
    maxWorkers: 8,
    execPrograms: { "/bin/bash": BASH, "/bin/sh": BASH },
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
  "fork: pipeline inside command substitution (COW child forks a pipeline)",
  () => {
    it("decodes and replays a pipeline-in-substitution fork without trapping", async () => {
      const { code, out } = await runBash(
        "echo $(echo b | while read x; do echo $x; done)",
      );
      expect(out).toContain("b");
      expect(code).toBe(0);
    }, 60_000);

    it("survives a multi-stage builtin pipeline", async () => {
      const { code, out } = await runBash(
        "printf 'l1\\nl2\\n' | while read x; do echo r$x; done",
      );
      expect(out).toContain("rl1");
      expect(out).toContain("rl2");
      expect(code).toBe(0);
    }, 60_000);
  },
);
