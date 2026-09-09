/**
 * Vitest globalSetup — compiles C test programs to .wasm, assembles
 * .wat test fixtures, and ensures the Playwright chromium browser is
 * installed before tests run.
 *
 * Uses wasm32posix-cc from the SDK for C, and wat2wasm (wabt) for WAT
 * fixtures. C outputs are rebuilt unless their embedded content digest covers
 * the exact source, compiler wrapper/version, installed sysroot, and (where
 * used) instrumenter binary. The chromium check is a no-op when the binary is
 * already cached.
 */

import { execFileSync } from "node:child_process";
import { statSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  captureProgramFixtureBuildContract,
  programFixtureNeedsRebuild,
  stampProgramFixture,
  type ProgramFixtureBuildContract,
} from "./program-fixture-freshness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const examplesDir = join(repoRoot, "examples");
const fixturesDir = join(__dirname, "fixtures");

const C_TEST_FIXTURES = [
  {
    src: join(fixturesDir, "process-memory-reclamation-churn.c"),
    out: join(fixturesDir, "process-memory-reclamation-churn.wasm"),
  },
  {
    // WHY: this executable validates host-runtime fork ownership only. Keep it
    // out of examples/, whose generic build loop treats every C file as a
    // developer-facing example/local program.
    src: join(fixturesDir, "fork-memory-clone.c"),
    out: join(fixturesDir, "fork-memory-clone.wasm"),
    forkInstrument: true,
  },
  {
    // Deep-fork fixture for the module-owned growing frame allocator: grows its
    // heap via a big malloc (tracked SYS_mmap) and forks from a deep linked
    // continuation, so fork-time continuation frames grow uncapped past the old
    // 2 MiB Fix X arena and still place coherently above the live heap.
    src: join(fixturesDir, "malloc-deep-fork.c"),
    out: join(fixturesDir, "malloc-deep-fork.wasm"),
    forkInstrument: true,
  },
];

/** Program fixtures resolved through the normal local-binaries contract. */
const RESOLVED_PROGRAM_FIXTURES = [
  {
    arch: "wasm32",
    src: join(repoRoot, "programs/scm-rights-pipe-lifetime.c"),
    out: join(
      repoRoot,
      "local-binaries/programs/wasm32/scm-rights-pipe-lifetime.wasm",
    ),
  },
  {
    arch: "wasm64",
    src: join(repoRoot, "programs/scm-rights-pipe-lifetime.c"),
    out: join(
      repoRoot,
      "local-binaries/programs/wasm64/scm-rights-pipe-lifetime.wasm",
    ),
  },
  {
    arch: "wasm32",
    src: join(repoRoot, "programs/scm-rights-semantics.c"),
    out: join(
      repoRoot,
      "local-binaries/programs/wasm32/scm-rights-semantics.wasm",
    ),
  },
  {
    // Recompiled from source so the H1 (no-grow) and M2 (close-after-mmap
    // writeback survives) checks added for the fd-writeback bridge are always
    // exercised against the current source, not a stale prebuilt binary.
    arch: "wasm32",
    src: join(repoRoot, "programs/mmap_shared_test.c"),
    out: join(
      repoRoot,
      "local-binaries/programs/wasm32/mmap_shared_test.wasm",
    ),
  },
  {
    arch: "wasm64",
    src: join(repoRoot, "programs/scm-rights-semantics.c"),
    out: join(
      repoRoot,
      "local-binaries/programs/wasm64/scm-rights-semantics.wasm",
    ),
  },
];

/** C programs that tests depend on. */
const TEST_PROGRAMS = [
  "clock_getcpuclockid_test.c",
  "syscall_cp_offset_test.c",
  "select_signal_test.c",
  "dsp_signal_test.c",
  "lseek_invalid_test.c",
  "environment_lifecycle_test.c",
  "chown_sentinel_test.c",
  "fstatat_empty_path_test.c",
  "pthread_channel_reuse_test.c",
  "wait_lifecycle_test.c",
  "pathconf_test.c",
  "getdents_boundary_test.c",
  "terminal_attributes_api_test.c",
  "rlimit_fsize_test.c",
  "kernel_scratch_browser_test.c",
  "socket_timeout_options_test.c",
  "unix_listener_exec_test.c",
  "putenv_test.c",
  "getaddrinfo_test.c",
  "process_native_layout_test.c",
  "timerfd_signalfd_scratch_test.c",
  "sysv_ipc_test.c",
  "wasm_trap_test.c",
  "oob_trap_test.c",
  "divzero_trap_test.c",
  "abort_test.c",
  "test-pthread.c",
  "pthread-normal-exit.c",
  "pthread-trap-child.c",
  "pthread-trap-wait.c",
  "echo.c",
  "hello.c",
  "spawn-smoke.c",
  "spawn-coverage.c",
  "spawn-pause.c",
  "block-forever.c",
  "signal-wait.c",
  "mount_probe_test.c",
  "getpwent_smoke.c",
  "initial-credentials-test.c",
  "locale_info_test.c",
  "thread-exit-group.c",
  "fifo_lifecycle_test.c",
  "kernel_allocator_churn_test.c",
];

/** Memory64 counterparts needed to prove pointer-width-neutral syscall input. */
const WASM64_TEST_PROGRAMS = ["lseek_invalid_test.c"];

const FORK_INSTRUMENTED_PROGRAMS = new Set([
  "environment_lifecycle_test.c",
  "pthread_channel_reuse_test.c",
  "unix_listener_exec_test.c",
  "wait_lifecycle_test.c",
  "fifo_lifecycle_test.c",
  "kernel_allocator_churn_test.c",
]);

/** WAT fixtures used by host runtime tests. */
const WAT_FIXTURES = [
  "deep-wasm-recursion.wat",
  "wasi-args.wat",
  "wasi-hello.wat",
  "wasi-scalar-abi.wat",
];

/**
 * Toolchain inputs whose change must force every compiled fixture to rebuild.
 * The syscall glue and the built libc are compiled into (or linked with) every
 * program, so a glue/libc edit that does not touch the test source would
 * otherwise leave stale `.wasm` fixtures behind an mtime-only cache.
 */
const FIXTURE_TOOLCHAIN_INPUTS = [
  join(repoRoot, "libc/glue/channel_syscall.c"),
  join(repoRoot, "sysroot/lib/libc.a"),
  join(repoRoot, "sysroot64/lib/libc.a"),
];

function newestToolchainMtimeMs(): number {
  let newest = 0;
  for (const input of FIXTURE_TOOLCHAIN_INPUTS) {
    if (existsSync(input)) {
      newest = Math.max(newest, statSync(input).mtimeMs);
    }
  }
  return newest;
}

function needsRebuild(srcFile: string, outFile: string): boolean {
  if (!existsSync(outFile)) return true;
  const srcStat = statSync(srcFile);
  const outStat = statSync(outFile);
  if (srcStat.mtimeMs > outStat.mtimeMs) return true;
  // Rebuild when the syscall glue or libc is newer than the artifact: those
  // are compiled/linked into every program but are not the test source.
  return newestToolchainMtimeMs() > outStat.mtimeMs;
}

function compileCTestProgram(
  src: string,
  out: string,
  forkInstrument: boolean,
): void {
  if (!forkInstrument) {
    execFileSync("wasm32posix-cc", [src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return;
  }

  const linked = `${out}.linked`;
  try {
    execFileSync("wasm32posix-cc", [src, "-o", linked], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    execFileSync(
      "bash",
      [
        join(repoRoot, "scripts/run-wasm-fork-instrument.sh"),
        linked,
        "-o",
        out,
      ],
      { cwd: repoRoot, stdio: "pipe" },
    );
  } finally {
    rmSync(linked, { force: true });
  }
}

function fixtureBuildContract(
  arch: "wasm32" | "wasm64",
  forkInstrumented: boolean,
): ProgramFixtureBuildContract {
  const compiler = `${arch}posix-cc`;
  const compilerVersion = execFileSync(compiler, ["--version"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const inputs = [
    join(repoRoot, "sdk/bin"),
    join(repoRoot, "sdk/src"),
    join(repoRoot, "sdk/package.json"),
    join(repoRoot, "sdk/package-lock.json"),
    join(repoRoot, arch === "wasm64" ? "sysroot64" : "sysroot"),
    // The syscall glue is compiled per-program from libc/glue (not from the
    // sysroot), so a glue-only edit must still invalidate the fixture cache.
    join(repoRoot, "libc/glue"),
  ];
  if (forkInstrumented) {
    const configuredTool = process.env.WASM_POSIX_FORK_INSTRUMENT;
    const instrumenter = configuredTool
      ? configuredTool
      : join(repoRoot, "tools/bin/wasm-fork-instrument");
    if (!existsSync(instrumenter) && !configuredTool) {
      execFileSync(
        "bash",
        [join(repoRoot, "scripts/build-fork-instrument-tool.sh")],
        { cwd: repoRoot, stdio: "pipe" },
      );
    }
    inputs.push(
      join(repoRoot, "scripts/run-wasm-fork-instrument.sh"),
      instrumenter,
    );
  }
  return captureProgramFixtureBuildContract(
    repoRoot,
    `${arch}\nfork=${forkInstrumented}\n${compilerVersion}`,
    inputs,
  );
}

export async function setup() {
  // The program package index is a generated artifact (gitignored), not a
  // committed one. Generate it here so resolver and package-system tests that
  // read packages/registry/program-packages.json directly get a fresh
  // projection without depending on a prior build — every caller of `vitest
  // run` gets the prereq for free, exactly like the wasm fixtures below.
  const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split(/\r?\n/)
    .find((line) => line.startsWith("host: "))
    ?.slice(6)
    .trim();
  if (!hostTarget) {
    throw new Error("[global-setup] could not determine the Rust host target");
  }
  console.log("[global-setup] Generating program package index...");
  execFileSync(
    "cargo",
    [
      "run",
      "-p",
      "xtask",
      "--target",
      hostTarget,
      "--quiet",
      "--",
      "build-deps",
      "program-index",
      "--source-repo-root",
      repoRoot,
      join(repoRoot, "packages/registry"),
      join(repoRoot, "packages/registry/program-packages.json"),
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );

  const wasm32Contract = fixtureBuildContract("wasm32", false);
  const wasm32ForkContract = fixtureBuildContract("wasm32", true);
  const wasm64Contract = fixtureBuildContract("wasm64", false);

  for (const { src, out, forkInstrument = false } of C_TEST_FIXTURES) {
    const contract = forkInstrument ? wasm32ForkContract : wasm32Contract;
    if (!programFixtureNeedsRebuild(src, out, contract)) continue;

    console.log(
      `[global-setup] Compiling ${src.slice(repoRoot.length + 1)}...`,
    );
    compileCTestProgram(src, out, forkInstrument);
    stampProgramFixture(src, out, contract);
  }

  for (const { arch, src, out } of RESOLVED_PROGRAM_FIXTURES) {
    const contract = arch === "wasm64" ? wasm64Contract : wasm32Contract;
    if (!programFixtureNeedsRebuild(src, out, contract)) continue;

    mkdirSync(dirname(out), { recursive: true });
    console.log(
      `[global-setup] Compiling ${src.slice(repoRoot.length + 1)} (${arch})...`,
    );
    execFileSync(`${arch}posix-cc`, [src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    stampProgramFixture(src, out, contract);
  }

  for (const cFile of TEST_PROGRAMS) {
    const src = join(examplesDir, cFile);
    const out = src.replace(/\.c$/, ".wasm");

    if (!existsSync(src)) {
      console.warn(`[global-setup] Source not found: ${src}, skipping`);
      continue;
    }

    const contract = FORK_INSTRUMENTED_PROGRAMS.has(cFile)
      ? wasm32ForkContract
      : wasm32Contract;
    if (!programFixtureNeedsRebuild(src, out, contract)) continue;

    console.log(`[global-setup] Compiling ${cFile}...`);
    compileCTestProgram(src, out, FORK_INSTRUMENTED_PROGRAMS.has(cFile));
    stampProgramFixture(src, out, contract);
  }

  for (const cFile of WASM64_TEST_PROGRAMS) {
    const src = join(examplesDir, cFile);
    const out = src.replace(/\.c$/, ".wasm64.wasm");

    if (!existsSync(src)) {
      console.warn(`[global-setup] Source not found: ${src}, skipping`);
      continue;
    }
    if (!programFixtureNeedsRebuild(src, out, wasm64Contract)) continue;

    console.log(`[global-setup] Compiling ${cFile} (wasm64)...`);
    execFileSync("wasm64posix-cc", [src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    stampProgramFixture(src, out, wasm64Contract);
  }

  for (const watFile of WAT_FIXTURES) {
    const src = join(fixturesDir, watFile);
    const out = src.replace(/\.wat$/, ".wasm");

    if (!existsSync(src)) {
      console.warn(`[global-setup] Source not found: ${src}, skipping`);
      continue;
    }

    if (!needsRebuild(src, out)) continue;

    console.log(`[global-setup] Assembling ${watFile}...`);
    execFileSync("wat2wasm", ["--enable-threads", src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }

  // packages/registry/wordpress/test/wordpress-site-editor.test.ts calls
  // chromium.launch() directly (not via the `playwright test` runner),
  // so the browser binary must be present before vitest runs. `npm
  // install` only fetches the @playwright/test JS package, not the
  // ~150 MB chromium-headless-shell. Owning this here means workflow
  // YAMLs no longer need to remember `npx playwright install chromium`
  // — every caller of `vitest run` gets the prereq for free.
  let chromiumPath = "";
  try {
    chromiumPath = chromium.executablePath();
  } catch {
    // executablePath() can throw on some Playwright versions when the
    // browser hasn't been downloaded yet; treat that the same as a
    // missing file and let the install step below run.
  }
  if (!chromiumPath || !existsSync(chromiumPath)) {
    console.log("[global-setup] Installing Playwright chromium...");
    execFileSync("npx", ["playwright", "install", "chromium"], {
      cwd: join(repoRoot, "host"),
      stdio: "inherit",
    });
  }
}
