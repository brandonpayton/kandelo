import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const instrumenter = resolve(
  fixturesDir,
  "../../../tools/bin/wasm-fork-instrument",
);

const ABI_VERSION_DECLARATION =
  /(\(func \(export "__abi_version"\) \(result i32\)\s+i32\.const )\d+/;

/**
 * Compile a .wat fixture whose `__abi_version` names the host's ABI.
 *
 * The host refuses any program whose declared ABI is not its own, so a fixture
 * that hardcodes one version stops running at the next bump — and it stops with
 * a bare non-zero exit and no guest output, which reads as a broken fixture
 * rather than a stale one. The .wat keeps the number it was authored with; only
 * the staged copy carries the current ABI.
 *
 * Node and browser tests share this one definition. Stamping in only one of
 * them leaves the other failing at the next bump for a reason its own source
 * does not show.
 */
export function buildAbiStampedFixture(
  source: string,
  workDir: string,
  name: string,
  abiVersion: number,
): string {
  const stagedSource = join(workDir, `${name}.wat`);
  const rawPath = join(workDir, `${name}.raw.wasm`);
  const programPath = join(workDir, `${name}.wasm`);
  const wat = readFileSync(source, "utf8");
  if (!ABI_VERSION_DECLARATION.test(wat)) {
    throw new Error(`${source} declares no __abi_version to stamp`);
  }
  writeFileSync(
    stagedSource,
    wat.replace(ABI_VERSION_DECLARATION, `$1${abiVersion}`),
  );
  execFileSync("wat2wasm", [
    "--enable-exceptions",
    "--enable-threads",
    stagedSource,
    "-o",
    rawPath,
  ]);
  execFileSync(instrumenter, [rawPath, "-o", programPath]);
  return programPath;
}
