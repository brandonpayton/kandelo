import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeviceFileSystem } from "../src/vfs/device-fs";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const probeBinary = join(
  repoRoot,
  "local-binaries/programs/wasm32/secure-exec-probe.wasm",
);
const hasProbe = true;
const SECURE_STDOUT_SENTINEL = "secure-stdout-sentinel\n";
const SECURE_STDERR_SENTINEL = "secure-stderr-sentinel\n";

// The probe's locale/catalog/timezone fixtures used to be staged at /tmp by a
// dedicated VirtualPlatformIO mount here. The in-kernel tmpfs is now the
// unconditional authority over /tmp (VFS: make in-kernel tmpfs scratch mounts
// unconditional; delete WASM_POSIX_TMPFS kill-switch), so a host-side /tmp
// mount is never consulted for a guest open under that scratch prefix.
// secure-exec-probe.c now writes its own fixtures into /tmp at the top of
// `check_sensitive_lookups`, through the same guest syscalls a real setuid
// target would use.

function createProbeIo(honorsSetId: boolean): VirtualPlatformIO {
  const bytes = new Uint8Array(readFileSync(probeBinary!));
  const root = MemoryFileSystem.create(
    new SharedArrayBuffer(Math.max(4 * 1024 * 1024, bytes.byteLength * 3)),
  );
  root.mkdir("/bin", 0o755);
  root.mkdir("/dev", 0o755);
  root.createFileWithOwner("/bin/secure-parent", 0o4755, 0, 0, bytes);
  root.createFileWithOwner("/bin/secure-child", 0o755, 0, 0, bytes);

  return new VirtualPlatformIO([
    { mountPoint: "/", backend: root, nosuid: !honorsSetId },
    { mountPoint: "/dev", backend: new DeviceFileSystem(), nosuid: true },
  ], new NodeTimeProvider());
}

async function launch(
  trusted: boolean,
  mode: "target" | "stdio-target" | "spawn-parent",
  secure: boolean,
  maskOrReset: number,
) {
  return runCentralizedProgram({
    programPath: probeBinary!,
    argv: [
      "secure-exec-probe",
      "launch",
      "/bin/secure-parent",
      mode,
      secure ? "1" : "0",
      String(maskOrReset),
    ],
    env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
    uid: 1000,
    gid: 1000,
    io: createProbeIo(trusted),
    execPrograms: new Map([["/bin/secure-child", probeBinary!]]),
    timeout: 20_000,
  });
}

describe.skipIf(!hasProbe)("secure exec startup", () => {
  it("keeps constructor dispatch out of the linker-synthesized entry prefix", () => {
    const disassembly = execFileSync(
      "wasm-objdump",
      ["-d", probeBinary!],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const startOffset = disassembly.search(/func\[\d+\] <_start>:/);
    const nextFunctionOffset = disassembly.indexOf(" func[", startOffset + 1);
    const startBody = disassembly.slice(
      startOffset,
      nextFunctionOffset < 0 ? undefined : nextFunctionOffset,
    );
    const argcCall = startBody.indexOf("<kernel.kernel_get_argc>");
    const secureCall = startBody.indexOf("<kernel.kernel_get_secure_exec>");
    const constructorDispatch = startBody.indexOf("call_indirect");

    expect(startOffset).toBeGreaterThanOrEqual(0);
    expect(argcCall).toBeGreaterThanOrEqual(0);
    expect(secureCall).toBeGreaterThan(argcCall);
    expect(constructorDispatch).toBeGreaterThan(secureCall);
  });

  it("keeps an ordinary image outside secure startup", async () => {
    const result = await runCentralizedProgram({
      programPath: probeBinary!,
      argv: ["secure-exec-probe", "target", "0", "0"],
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
      io: createProbeIo(false),
      uid: 1000,
      gid: 1000,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
    );
    expect(result.stdout).toContain(
      "locale=Lok timezone=TST catalog=loaded fds=ok",
    );
  });

  it("carries the ordinary marker through the production Node worker host", async () => {
    const result = await runCentralizedProgram({
      programPath: probeBinary!,
      argv: ["secure-exec-probe", "startup-target", "0", "0"],
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
      uid: 1000,
      gid: 1000,
      useDefaultRootfs: false,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
    );
  });

  it("enters secure startup for a set-ID exec on an ordinary writable VFS", async () => {
    const result = await launch(true, "target", true, 0);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0",
    );
    expect(result.stdout).toContain(
      "locale=Sun timezone=UTC catalog=blocked fds=ok",
    );
  });

  it("does not enter secure startup for an explicitly nosuid set-ID file", async () => {
    const result = await launch(false, "target", false, 0);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
    );
  });

  it.each([
    [0, "preserves", true],
    [1, "resets", false],
  ] as const)(
    "%s: posix_spawn %s IDs before exact secure-state commit",
    async (resetIds, _verb, expectedSecure) => {
      const result = await launch(true, "spawn-parent", true, resetIds);
      expect(result.exitCode).toBe(0);
      if (expectedSecure) {
        expect(result.stdout).toContain(
          "secure=1 ctor_secure=1 untrusted_visible=0 ctor_visible=0",
        );
      } else {
        expect(result.stdout).toContain(
          "secure=0 ctor_secure=0 untrusted_visible=1 ctor_visible=1",
        );
      }
    },
  );

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "repairs secure standard descriptors for closed mask %i",
    async (mask) => {
      const result = await launch(true, "stdio-target", true, mask);
      expect(result.exitCode).toBe(0);
      if (mask & 2) {
        expect(result.stdout).not.toContain(SECURE_STDOUT_SENTINEL);
      } else {
        expect(result.stdout).toContain(SECURE_STDOUT_SENTINEL);
      }
      if (mask & 4) {
        expect(result.stderr).not.toContain(SECURE_STDERR_SENTINEL);
      } else {
        expect(result.stderr).toContain(SECURE_STDERR_SENTINEL);
      }
    },
  );

  it("does not repair closed standard descriptors for an ordinary image", async () => {
    const result = await launch(false, "stdio-target", false, 1);
    expect(result.exitCode).toBe(40);
  });

  it("exits 127 when secure standard-descriptor repair cannot allocate a descriptor", async () => {
    const result = await runCentralizedProgram({
      programPath: probeBinary!,
      argv: [
        "secure-exec-probe",
        "launch-nofile",
        "/bin/secure-parent",
        "stdio-target",
        "1",
        "1",
      ],
      env: ["KANDELO_UNTRUSTED=visible-only-outside-secure-startup"],
      uid: 1000,
      gid: 1000,
      io: createProbeIo(true),
      execPrograms: new Map([["/bin/secure-child", probeBinary!]]),
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(127);
  });
});
