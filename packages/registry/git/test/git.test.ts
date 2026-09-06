/**
 * Tests for Git 2.47.1 running on the kandelo.
 *
 * Git is built with wpk_fork_* instrumentation for fork() support so that
 * subprocesses (git gc --auto, git-remote-http, index-pack) work correctly.
 *
 * Persistent native paths are rooted in random, test-owned directories so
 * append ownership remains explicit across the complete guest lifetime.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { execSync, spawn } from "node:child_process";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { FetchNetworkBackend } from "../../../../host/src/networking/fetch-backend";
import { TlsNetworkBackend } from "../../../../host/src/networking/tls-network-backend";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { createSessionOwnedHostFileSystem } from "../../../../host/src/vfs/host-fs";
import { NodeTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";

const gitBinary = tryResolveBinary("programs/git/git.wasm");
const gitRemoteHttpBinary = tryResolveBinary(
  "programs/git/git-remote-http.wasm",
);

// Phase 7: skip git tests when the resolved binaries predate the
// wasm-fork-instrument flip (i.e. they still export asyncify_* instead
// of wpk_fork_*). Detect by reading the wasm module and looking for
// the new export name; a stale binary causes kernel ABI mismatch at
// launch and the test hangs on startup rather than producing a clean skip.
function hasWpkForkExports(path: string | null): boolean {
  if (!path) return false;
  try {
    const bytes = readFileSync(path);
    return bytes.includes(Buffer.from("wpk_fork_state"));
  } catch {
    return false;
  }
}

const hasGit = !!gitBinary && hasWpkForkExports(gitBinary);
const hasGitRemoteHttp =
  !!gitRemoteHttpBinary && hasWpkForkExports(gitRemoteHttpBinary);

function createOwnedGuestIo(root: string): VirtualPlatformIO {
  mkdirSync(root, { recursive: true });
  // WHY: the random root is exclusively owned by this test for the complete
  // guest lifetime, so the backend can truthfully publish exact append ends.
  return new VirtualPlatformIO(
    [
      {
        mountPoint: "/",
        backend: createSessionOwnedHostFileSystem(root),
      },
    ],
    new NodeTimeProvider(),
  );
}

// Git config via environment
const gitEnv = [
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_COUNT=4",
  "GIT_CONFIG_KEY_0=gc.auto",
  "GIT_CONFIG_VALUE_0=0",
  "GIT_CONFIG_KEY_1=user.name",
  "GIT_CONFIG_VALUE_1=Test",
  "GIT_CONFIG_KEY_2=user.email",
  "GIT_CONFIG_VALUE_2=test@wasm.local",
  "GIT_CONFIG_KEY_3=init.defaultBranch",
  "GIT_CONFIG_VALUE_3=main",
];

describe.skipIf(!hasGit)("Git", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "--version"],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version 2.");
  });

  it("initializes a repository", async () => {
    const dir = `/tmp/git-test-init-${Date.now()}`;
    const result = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "init", dir],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("nitialized");
  });

  it(
    "creates a commit without spurious help output (wpk_fork instrumentation)",
    { timeout: 30_000 },
    async () => {
      // git commit triggers fork+exec for `git gc --auto`. Without fork
      // instrumentation, the fork child restarts from _start() with empty argv
      // and prints help.
      const dir = "/tmp/repo";
      const program = readFileSync(gitBinary!);
      const programBytes = program.buffer.slice(
        program.byteOffset,
        program.byteOffset + program.byteLength,
      );
      let output = "";
      const host = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: (_pid, data) => {
          output += new TextDecoder().decode(data);
        },
        onStderr: (_pid, data) => {
          output += new TextDecoder().decode(data);
        },
      });
      try {
        await host.init();
        expect(
          await host.spawn(programBytes, ["git", "init", dir], {
            env: gitEnv,
          }),
        ).toBe(0);
        output = "";
        // WHY: both operations share one dedicated kernel session, so /tmp
        // retains its lifecycle-owned append authority across the process exit.
        expect(
          await host.spawn(
            programBytes,
            ["git", "-C", dir, "commit", "--allow-empty", "-m", "test commit"],
            { env: gitEnv },
          ),
        ).toBe(0);
        expect(output).toContain("test commit");
        expect(output).not.toContain("usage: git");
      } finally {
        await host.destroy();
      }
    },
  );
});

/**
 * Git HTTP clone tests — verifies git can clone from a dumb HTTP server.
 *
 * Setup:
 * 1. Creates a bare git repo with one commit on the host filesystem
 * 2. Runs `git update-server-info` to generate dumb-HTTP metadata
 * 3. Serves the repo via a local Node.js HTTP server
 * 4. Wasm git clones from a host-only test alias
 *
 * The FetchNetworkBackend converts git's raw TCP socket operations into
 * fetch() calls. git-remote-http (fork+exec'd by git) handles the HTTP
 * transport protocol.
 */
describe.skipIf(!hasGit || !hasGitRemoteHttp)("Git HTTP clone", () => {
  let httpServer: Server;
  let httpPort: number;
  let tmpBase: string;
  let guestRoot: string;
  const hostAlias = "kandelo-host.test";

  beforeAll(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), "kandelo-git-http-"));
    guestRoot = join(tmpBase, "guest");
    mkdirSync(guestRoot);
    const workDir = `${tmpBase}/work`;
    const bareRepoDir = `${tmpBase}/repo.git`;

    const gitOpts = {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    };

    execSync(`git init "${workDir}"`, gitOpts);
    execSync(`echo "hello from kandelo" > "${workDir}/test.txt"`, gitOpts);
    execSync(`git -C "${workDir}" add test.txt`, gitOpts);
    execSync(`git -C "${workDir}" commit -m "initial commit"`, gitOpts);
    execSync(`git clone --bare "${workDir}" "${bareRepoDir}"`, gitOpts);
    execSync(`git -C "${bareRepoDir}" repack -ad`, gitOpts);
    execSync(`git -C "${bareRepoDir}" update-server-info`, gitOpts);

    // Serve the bare repo as static files (dumb HTTP protocol)
    httpServer = createServer((req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      const filePath = join(bareRepoDir, urlPath);
      try {
        if (!existsSync(filePath)) {
          res.writeHead(404);
          res.end("Not found\n");
          return;
        }
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          res.writeHead(404);
          res.end("Not found\n");
          return;
        }
        const data = readFileSync(filePath);
        res.writeHead(200);
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found\n");
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    httpPort = (httpServer.address() as any).port;
  });

  afterAll(() => {
    httpServer?.close();
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it(
    "clones a repository via HTTP (dumb protocol)",
    { timeout: 60_000 },
    async () => {
      const io = createOwnedGuestIo(guestRoot);
      io.network = new FetchNetworkBackend({
        hostAliases: { [hostAlias]: "127.0.0.1" },
      });

      const cloneDir = `/clone-${Date.now()}`;
      const cloneHostDir = join(guestRoot, cloneDir.slice(1));

      // Git's prepare_cmd() resolves helper commands via locate_in_PATH(),
      // which uses access() against the guest filesystem, and then execs the
      // path it found. execve reads that file: its authority is the executable
      // already present in the VFS, never a host-side program map. Stage the
      // real Wasm at each helper path so both steps see the same program.
      const gitExecPath = "/exec";
      const hostGitExecPath = join(guestRoot, "exec");
      mkdirSync(hostGitExecPath, { recursive: true });
      for (const [name, binary] of [
        ["git-remote-http", gitRemoteHttpBinary!],
        // git re-execs itself through GIT_EXEC_PATH as well.
        ["git", gitBinary!],
      ] as const) {
        writeFileSync(join(hostGitExecPath, name), readFileSync(binary), {
          mode: 0o755,
        });
      }

      const cloneEnv = [...gitEnv, `GIT_EXEC_PATH=${gitExecPath}`];

      const result = await runCentralizedProgram({
        programPath: gitBinary!,
        argv: ["git", "clone", `http://${hostAlias}:${httpPort}/`, cloneDir],
        env: cloneEnv,
        io,
        timeout: 60_000,
      });

      const output = result.stdout + result.stderr;
      if (result.exitCode !== 0) {
        console.error("Git clone failed with exit code:", result.exitCode);
        console.error("stdout:", result.stdout);
        console.error("stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(output).toContain("Cloning into");

      // Verify the cloned repo has the expected file
      expect(existsSync(join(cloneHostDir, ".git"))).toBe(true);
      const testFile = readFileSync(join(cloneHostDir, "test.txt"), "utf-8");
      expect(testFile.trim()).toBe("hello from kandelo");

      // Cleanup
      try {
        rmSync(cloneHostDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  );
});

/**
 * Git HTTPS clone over the browser TLS-MITM path (smart protocol).
 *
 * This is the deterministic, no-external-network counterpart to the manual
 * browser demo verification. It exercises the whole browser clone path end to
 * end against a local git-http-backend server:
 *   - `TlsNetworkBackend` terminates the guest's real TLS at :443 and re-issues
 *     each request via fetch() (keep-alive reuse across info/refs + upload-pack)
 *   - git gzip-compresses the upload-pack fetch command; the backend de-gzips it
 *   - git-remote-http verifies the per-session MITM cert via GIT_SSL_CAINFO,
 *     mirroring the env the browser worker injects (withBrowserMitmCaEnv)
 * A stubbed global fetch routes the alias host to the local smart-HTTP server.
 */
function resolveGitHttpBackend(): string | null {
  try {
    const execPath = execSync("git --exec-path").toString().trim();
    const candidate = join(execPath, "git-http-backend");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const gitHttpBackend = resolveGitHttpBackend();

/** Minimal CGI wrapper around git-http-backend serving the git smart protocol. */
function createSmartHttpServer(projectRoot: string, backendPath: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_PROJECT_ROOT: projectRoot,
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ""),
      REQUEST_METHOD: req.method ?? "GET",
      CONTENT_TYPE: (req.headers["content-type"] as string) ?? "",
    };
    const contentLength = req.headers["content-length"];
    if (typeof contentLength === "string") env.CONTENT_LENGTH = contentLength;
    const gitProtocol = req.headers["git-protocol"];
    if (typeof gitProtocol === "string") env.GIT_PROTOCOL = gitProtocol;

    const cgi = spawn(backendPath, [], { env });
    req.pipe(cgi.stdin);
    const chunks: Buffer[] = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.stdout.on("end", () => {
      const out = Buffer.concat(chunks);
      let separator = out.indexOf("\r\n\r\n");
      let separatorLen = 4;
      if (separator < 0) {
        separator = out.indexOf("\n\n");
        separatorLen = 2;
      }
      const headerText = separator < 0 ? "" : out.subarray(0, separator).toString("utf8");
      const body = separator < 0 ? out : out.subarray(separator + separatorLen);
      let status = 200;
      for (const line of headerText.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key.toLowerCase() === "status") status = parseInt(value, 10) || 200;
        else res.setHeader(key, value);
      }
      res.writeHead(status);
      res.end(body);
    });
    cgi.on("error", (error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
}

describe.skipIf(!hasGit || !hasGitRemoteHttp || !gitHttpBackend)(
  "Git HTTPS clone (smart protocol via TLS MITM)",
  () => {
    let httpServer: Server;
    let httpPort: number;
    let tmpBase: string;
    let guestRoot: string;
    const alias = "gitserver.test";

    beforeAll(async () => {
      tmpBase = mkdtempSync(join(tmpdir(), "kandelo-git-https-"));
      guestRoot = join(tmpBase, "guest");
      mkdirSync(guestRoot);
      const workDir = `${tmpBase}/work`;
      const reposDir = `${tmpBase}/repos`;
      mkdirSync(reposDir);
      const bareRepoDir = `${reposDir}/repo.git`;

      const gitOpts = {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_COMMITTER_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@test.com",
          GIT_COMMITTER_EMAIL: "test@test.com",
        },
      };
      execSync(`git init "${workDir}"`, gitOpts);
      execSync(`echo "hello over https" > "${workDir}/test.txt"`, gitOpts);
      execSync(`git -C "${workDir}" add test.txt`, gitOpts);
      execSync(`git -C "${workDir}" commit -m "initial commit"`, gitOpts);
      execSync(`git clone --bare "${workDir}" "${bareRepoDir}"`, gitOpts);
      execSync(`git -C "${bareRepoDir}" update-server-info`, gitOpts);

      httpServer = createSmartHttpServer(reposDir, gitHttpBackend!);
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      httpPort = (httpServer.address() as { port: number }).port;
    });

    afterAll(() => {
      httpServer?.close();
      vi.unstubAllGlobals();
      try {
        rmSync(tmpBase, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it(
      "clones over HTTPS: TLS-MITM keep-alive + gzip request body + MITM CA trust",
      { timeout: 90_000 },
      async () => {
        const backend = new TlsNetworkBackend();
        await backend.init();

        // Route the MITM's outbound fetch() for the alias host to the local
        // smart-HTTP server; everything else falls through to real fetch.
        const realFetch = globalThis.fetch;
        vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
          const raw = typeof input === "string"
            ? input
            : input instanceof URL
            ? input.href
            : input.url;
          const parsed = new URL(raw);
          if (parsed.hostname === alias) {
            return realFetch(
              `http://127.0.0.1:${httpPort}${parsed.pathname}${parsed.search}`,
              init,
            );
          }
          return realFetch(input, init);
        });

        const io = createOwnedGuestIo(guestRoot);
        io.network = backend;

        // Install the per-session MITM CA where GIT_SSL_CAINFO points, mirroring
        // what the browser kernel worker does at runtime.
        const caDir = join(guestRoot, "etc/ssl/certs");
        mkdirSync(caDir, { recursive: true });
        writeFileSync(join(caDir, "ca-certificates.crt"), backend.getCACertPEM());

        const cloneDir = `/clone-${Date.now()}`;
        const cloneHostDir = join(guestRoot, cloneDir.slice(1));

        const gitExecPath = "/exec";
        const hostGitExecPath = join(guestRoot, "exec");
        mkdirSync(hostGitExecPath, { recursive: true });
        // git-remote-http serves both http and https; git execs it as
        // git-remote-https for an https URL (the real image symlinks it).
        const remoteHttpBytes = readFileSync(gitRemoteHttpBinary!);
        for (const name of ["git-remote-http", "git-remote-https"]) {
          writeFileSync(join(hostGitExecPath, name), remoteHttpBytes, {
            mode: 0o755,
          });
        }
        writeFileSync(join(hostGitExecPath, "git"), readFileSync(gitBinary!), {
          mode: 0o755,
        });
        const execPrograms = new Map<string, string>([
          [`${gitExecPath}/git-remote-http`, gitRemoteHttpBinary!],
          [`${gitExecPath}/git-remote-https`, gitRemoteHttpBinary!],
          [`${gitExecPath}/git`, gitBinary!],
          ["/usr/libexec/git-core/git-remote-https", gitRemoteHttpBinary!],
          ["/usr/libexec/git-core/git-remote-http", gitRemoteHttpBinary!],
          ["/usr/bin/git-remote-https", gitRemoteHttpBinary!],
          ["/usr/bin/git-remote-http", gitRemoteHttpBinary!],
          ["/usr/bin/git", gitBinary!],
        ]);

        const cloneEnv = [
          ...gitEnv,
          `GIT_EXEC_PATH=${gitExecPath}`,
          "GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt",
        ];

        const result = await runCentralizedProgram({
          programPath: gitBinary!,
          argv: ["git", "clone", `https://${alias}/repo.git`, cloneDir],
          env: cloneEnv,
          io,
          execPrograms,
          timeout: 90_000,
        });

        const output = result.stdout + result.stderr;
        if (result.exitCode !== 0) {
          console.error("HTTPS clone failed, exit:", result.exitCode);
          console.error("stdout:", result.stdout);
          console.error("stderr:", result.stderr);
        }
        expect(output).not.toContain("SSL certificate problem");
        expect(result.exitCode).toBe(0);
        expect(output).toContain("Cloning into");
        expect(existsSync(join(cloneHostDir, ".git"))).toBe(true);
        const testFile = readFileSync(join(cloneHostDir, "test.txt"), "utf-8");
        expect(testFile.trim()).toBe("hello over https");

        try {
          rmSync(cloneHostDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    );
  },
);
