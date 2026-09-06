import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { binaryCacheRoot } from "../../src/binary-resolver";

/**
 * The Doom shareware IWAD the fbDOOM checkpoint tests run against.
 *
 * Same pinned source as `images/vfs/products/browser-main-shell.toml`: the
 * browser demo fetches this file at page load, so the tests exercise the same
 * asset the product ships. Fetched once, verified against the pinned sha256,
 * and cached beside the resolver's package generations.
 */
const DOOM_WAD_URL =
  "https://cdn.jsdelivr.net/gh/gaborbata/vanilla-mocha-doom@15825a07a48806bcfb242a42afd5ee7cb3c9a3a4/wads/doom1.wad";
const DOOM_WAD_SHA256 =
  "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";

export async function doomSharewareWad(): Promise<Uint8Array> {
  const cachePath = join(
    binaryCacheRoot(),
    "archives",
    `doom-shareware-${DOOM_WAD_SHA256.slice(0, 8)}.wad`,
  );
  const sha256 = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
  try {
    // A fresh copy, because writeFileToVfs transfers the backing buffer and
    // a readFileSync Buffer sits in a pool it does not own.
    const cached = new Uint8Array(readFileSync(cachePath));
    if (sha256(cached) === DOOM_WAD_SHA256) return cached;
  } catch {
    // Not cached yet.
  }
  const response = await fetch(DOOM_WAD_URL);
  if (!response.ok) {
    throw new Error(`fetching ${DOOM_WAD_URL} failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (digest !== DOOM_WAD_SHA256) {
    throw new Error(
      `${DOOM_WAD_URL} hashed to ${digest}, expected ${DOOM_WAD_SHA256}`,
    );
  }
  mkdirSync(join(binaryCacheRoot(), "archives"), { recursive: true });
  writeFileSync(cachePath, bytes);
  return bytes;
}
