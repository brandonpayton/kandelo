import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const verifiedArchivePackages = [
  ["dash", "DASH_VERSION", "auto"],
  ["bash", "BASH_VERSION_PKG", "auto"],
  ["ncurses", "NCURSES_VERSION", "auto"],
  ["coreutils", "COREUTILS_VERSION", "auto"],
  ["gawk", "GAWK_VERSION", "auto"],
  ["grep", "GREP_VERSION", "auto"],
  ["sed", "SED_VERSION", "auto"],
  ["bc", "BC_VERSION", "auto"],
  ["file", "FILE_VERSION", "auto"],
  ["m4", "M4_VERSION", "auto"],
  ["make", "MAKE_VERSION", "auto"],
  ["findutils", "FINDUTILS_VERSION", "auto"],
  ["diffutils", "DIFFUTILS_VERSION", "auto"],
] as const;

const gnuMirrorPackages = [
  "bash",
  "bc",
  "coreutils",
  "diffutils",
  "findutils",
  "gawk",
  "grep",
  "gzip",
  "m4",
  "make",
  "nano",
  "sed",
  "tar",
  "wget",
] as const;

function manifestField(source: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) throw new Error(`missing ${label}`);
  return value;
}

function sourceField(manifest: string, field: "url" | "sha256"): string {
  const sourceBlock = manifest.split(/^\[source\]\s*$/m)[1]?.split(/^\[/m)[0];
  if (sourceBlock === undefined) throw new Error("missing [source] block");
  return manifestField(
    sourceBlock,
    new RegExp(`^${field}\\s*=\\s*"([^"]+)"$`, "m"),
    `source ${field}`,
  );
}

describe("source-rootfs verified archive contract", () => {
  const rootfsManifest = readFileSync(
    resolve(repoRoot, "packages/registry/rootfs/package.toml"),
    "utf8",
  );

  it("uses the ncurses maintainer archive mirror for the hash-verified source", () => {
    const manifest = readFileSync(
      resolve(repoRoot, "packages/registry/ncurses/package.toml"),
      "utf8",
    );

    expect(sourceField(manifest, "url")).toBe(
      "https://invisible-mirror.net/archives/ncurses/ncurses-6.5.tar.gz",
    );
    expect(sourceField(manifest, "sha256")).toBe(
      "136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6",
    );
  });

  for (const [
    packageName,
    versionVariable,
    forkInstrumentation,
  ] of verifiedArchivePackages) {
    it(`${packageName} binds isolated builds to its manifest source`, () => {
      const manifest = readFileSync(
        resolve(repoRoot, `packages/registry/${packageName}/package.toml`),
        "utf8",
      );
      const buildScript = readFileSync(
        resolve(
          repoRoot,
          `packages/registry/${packageName}/build-${packageName}.sh`,
        ),
        "utf8",
      );
      const buildToml = readFileSync(
        resolve(repoRoot, `packages/registry/${packageName}/build.toml`),
        "utf8",
      );
      const version = manifestField(
        manifest,
        /^version\s*=\s*"([^"]+)"$/m,
        "package version",
      );
      const sourceUrl = sourceField(manifest, "url");
      const sourceSha256 = sourceField(manifest, "sha256");
      expect(sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      const sourceUrlTemplate = sourceUrl.replace(
        version,
        `\${${versionVariable}}`,
      );

      expect(buildScript).toContain(
        `${versionVariable}="\${WASM_POSIX_DEP_VERSION:-\${${versionVariable}:-${version}}}"`,
      );
      expect(buildScript).toContain(
        `SOURCE_URL="\${WASM_POSIX_DEP_SOURCE_URL:-${sourceUrlTemplate}}"`,
      );
      expect(buildScript).toContain(
        `SOURCE_SHA256="\${WASM_POSIX_DEP_SOURCE_SHA256:-${sourceSha256}}"`,
      );
      expect(buildScript).toContain(
        'VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"',
      );
      expect(buildScript).toContain("scripts/package-build-roots.sh");
      expect(buildScript).toContain("kandelo_package_prepare_build_roots");
      expect(buildScript).toContain(
        `kandelo_package_stage_verified_source ${packageName}`,
      );
      expect(buildScript).toContain("WASM_POSIX_INSTALL_LOCAL_MIRROR=0");
      expect(buildScript).toContain(
        `WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=${forkInstrumentation}`,
      );
      expect(buildScript).toMatch(/^SRC_DIR="\$WORK_DIR\//m);
      expect(buildScript).not.toContain('SRC_DIR="$SCRIPT_DIR/');
      expect(buildScript).not.toContain('"$SCRIPT_DIR/bin/');
      expect(buildScript).not.toContain("curl ");
      expect(buildScript).not.toContain('"/tmp/$TARBALL"');
      expect(buildToml).toContain('"scripts/package-build-roots.sh"');
      expect(buildToml).toMatch(/^commit\s*=\s*"UNPUBLISHED"$/m);
      expect(rootfsManifest).toContain(`"${packageName}@${version}"`);
    });
  }

  it("uses GNU's canonical mirror-selector path", () => {
    for (const packageName of gnuMirrorPackages) {
      const mirrorSelectorPath =
        packageName === "bc" ? "gnu/bc" : packageName;
      const manifest = readFileSync(
        resolve(repoRoot, `packages/registry/${packageName}/package.toml`),
        "utf8",
      );
      const buildScript = readFileSync(
        resolve(
          repoRoot,
          `packages/registry/${packageName}/build-${packageName}.sh`,
        ),
        "utf8",
      );
      const sourceUrl = sourceField(manifest, "url");

      expect(sourceUrl, packageName).toMatch(
        new RegExp(
          `^https://ftpmirror\\.gnu\\.org/${mirrorSelectorPath.replaceAll("-", "\\-")}/`,
        ),
      );
      if (packageName === "bc") {
        expect(buildScript, packageName).toContain(
          "https://ftpmirror.gnu.org/gnu/bc/",
        );
      } else {
        expect(buildScript, packageName).not.toContain(
          "https://ftpmirror.gnu.org/gnu/",
        );
      }
    }
  });

  it("generates bc's host table without an ambient ed", () => {
    const scratch = mkdtempSync(resolve(tmpdir(), "kandelo-bc-libmath-"));
    try {
      writeFileSync(
        resolve(scratch, "libmath.h"),
        "first generated line\nsecond generated line\nfbc marker\n",
      );
      execFileSync(
        "python3",
        [resolve(repoRoot, "packages/registry/bc/fix-libmath-h.py")],
        { cwd: scratch, stdio: "pipe" },
      );
      expect(readFileSync(resolve(scratch, "libmath.h"), "utf8")).toBe(
        '{"first generated line",\n"second generated line",0}\n',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("composes rootfs only from resolver-owned dependency, work, and output roots", () => {
    const wrapper = readFileSync(
      resolve(
        repoRoot,
        "packages/registry/rootfs/build-rootfs-package.sh",
      ),
      "utf8",
    );
    const builder = readFileSync(
      resolve(repoRoot, "scripts/build-rootfs.sh"),
      "utf8",
    );
    const buildToml = readFileSync(
      resolve(repoRoot, "packages/registry/rootfs/build.toml"),
      "utf8",
    );

    expect(wrapper).toContain("WASM_POSIX_DEP_WORK_DIR");
    expect(wrapper).toContain('ROOTFS_OUT="$VFS"');
    expect(wrapper).toContain(
      'ROOTFS_BINARIES_DIR="$work_real/rootfs-binaries"',
    );
    expect(wrapper).toContain("ROOTFS_STAGE_RESOLVER_BINARIES=1");
    expect(wrapper).toContain("ROOTFS_SEALED_BUILD=1");
    expect(builder).toContain("--stage-resolver-binaries");
    expect(builder).toContain("node_modules/tsx/dist/cli.mjs");
    expect(buildToml).toContain('"package-lock.json"');
    expect(buildToml).toMatch(/^revision\s*=\s*11$/m);
    expect(buildToml).toMatch(/^commit\s*=\s*"UNPUBLISHED"$/m);
  });
});
