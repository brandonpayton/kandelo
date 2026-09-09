import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS } from "../src/generated/abi";
import type { PreparedExecLaunchRequest } from "../src/exec-target";

const PREPARED_EXEC_EXPORTS = [
  "kernel_exec_target_prepare",
  "kernel_spawn_exec_target_prepare",
  "kernel_exec_target_size",
  "kernel_exec_target_read",
  "kernel_exec_target_shebang",
  "kernel_exec_target_cancel",
  "kernel_exec_commit",
  "kernel_publish_spawn_child",
  "kernel_spawn_exec_commit",
] as const;

const LEGACY_PATHNAME_EXEC_EXPORTS = [
  "kernel_exec_prepare",
  "kernel_exec_setup",
  "kernel_exec_setup_for_thread",
  "kernel_execve",
  "kernel_execveat",
] as const;

describe("prepared exec target ABI", () => {
  it("keeps kernel commit authority out of the async launch request", () => {
    type NoCommitAuthority = Extract<
      "commit" | "target" | "ownerPid" | "callerTid",
      keyof PreparedExecLaunchRequest
    > extends never
      ? "sealed"
      : never;
    const noCommitAuthority: NoCommitAuthority = "sealed";
    const source = readFileSync(
      new URL("../src/exec-target.ts", import.meta.url),
      "utf8",
    );
    const requestStart = source.indexOf(
      "export interface PreparedExecLaunchRequest",
    );
    const requestEnd = source.indexOf("\n}", requestStart);

    expect(noCommitAuthority).toBe("sealed");
    expect(requestStart).toBeGreaterThanOrEqual(0);
    const requestSource = source.slice(requestStart, requestEnd);
    expect(requestSource).not.toContain("commit");
    expect(requestSource).not.toMatch(/\b(target|ownerPid|callerTid)\b/);
  });

  it("requires every exact-target operation and no targetless exec authority", () => {
    expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).toEqual(
      expect.arrayContaining(PREPARED_EXEC_EXPORTS),
    );
    for (const legacy of LEGACY_PATHNAME_EXEC_EXPORTS) {
      expect(HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS).not.toContain(legacy);
    }
  });

  it("publishes only exact-target exec exports in the ABI snapshot", () => {
    const snapshot = JSON.parse(readFileSync(
      new URL("../../abi/snapshot.json", import.meta.url),
      "utf8",
    )) as {
      kernel_exports: Array<{ name: string; signature: string }>;
    };
    const execExports = snapshot.kernel_exports
      .filter(({ name }) =>
        (PREPARED_EXEC_EXPORTS as readonly string[]).includes(name)
      )
      .map(({ name, signature }) => ({ name, signature }));
    expect(execExports).toEqual([
      { name: "kernel_exec_commit", signature: "(i32,i32,i32) -> (i32)" },
      { name: "kernel_exec_target_cancel", signature: "(i32,i32) -> (i32)" },
      {
        name: "kernel_exec_target_prepare",
        signature: "(i32,i32,i32,i32,i32,i32) -> (i32)",
      },
      {
        name: "kernel_exec_target_read",
        signature: "(i32,i32,i32,i32,i32,i32) -> (i32)",
      },
      {
        name: "kernel_exec_target_shebang",
        signature: "(i32,i32,i32,i32) -> (i32)",
      },
      { name: "kernel_exec_target_size", signature: "(i32,i32) -> (i64)" },
      { name: "kernel_publish_spawn_child", signature: "(i32,i32) -> (i32)" },
      { name: "kernel_spawn_exec_commit", signature: "(i32,i32,i32) -> (i32)" },
      {
        name: "kernel_spawn_exec_target_prepare",
        signature: "(i32,i32,i32,i32) -> (i32)",
      },
    ]);
    for (const legacy of LEGACY_PATHNAME_EXEC_EXPORTS) {
      expect(snapshot.kernel_exports.find(({ name }) => name === legacy))
        .toBeUndefined();
    }
  });

  it("documents exact prepared-target authority without legacy pathname authority", () => {
    const architecture = readFileSync(
      new URL("../../docs/architecture.md", import.meta.url),
      "utf8",
    );
    const execFlowStart = architecture.indexOf("### exec()");
    const execFlowEnd = architecture.indexOf("\n### ", execFlowStart + 1);
    expect(execFlowStart).toBeGreaterThanOrEqual(0);
    expect(execFlowEnd).toBeGreaterThan(execFlowStart);
    const execFlow = architecture.slice(execFlowStart, execFlowEnd);
    const posixStatus = readFileSync(
      new URL("../../docs/posix-status.md", import.meta.url),
      "utf8",
    );
    const execveatRow = posixStatus.split("\n")
      .find((line) => line.startsWith("| `execveat()`"));

    expect(execFlow).toContain("materialization hint");
    expect(execFlow).toContain("diagnostic-only");
    expect(execFlow).toMatch(/replacement\s+`WebAssembly\.Memory`/);
    for (const operation of [
      "kernel_exec_target_prepare",
      "kernel_exec_target_size",
      "kernel_exec_target_read",
      "kernel_exec_target_cancel",
      "kernel_exec_commit",
    ]) {
      expect(execFlow, `exec flow must name ${operation}`).toContain(operation);
      expect(execveatRow, `execveat row must name ${operation}`).toContain(operation);
    }
    expect(execFlow).toMatch(/exact bytes.*ABI.*compil/is);
    expect(execFlow).toMatch(/retained target.*revalidat.*commit/is);
    expect(execveatRow).toContain("diagnostic-only");
    expect(execveatRow).toContain("replacement-memory preflight");
    expect(execveatRow).toMatch(/compil.*exact bytes.*ABI/is);
    expect(execveatRow).toMatch(/revalidat.*commit/is);

    for (const legacy of [
      "kernel_exec_prepare",
      "kernel_exec_setup_for_thread",
    ]) {
      expect(architecture).not.toMatch(new RegExp(`${legacy}(?:\\(|\\b)`));
      expect(execveatRow).not.toMatch(new RegExp(`${legacy}(?:\\(|\\b)`));
    }
    expect(execFlow).not.toMatch(/resolves .*program map/is);
  });
});
