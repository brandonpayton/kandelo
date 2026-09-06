import { expect, test } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appUrl, networkButton, openNetworkPopover } from "./support/peer-pair";

/**
 * Two Kandelo computers connected by a session name through the signalling
 * piplet (`apps/signalling/piplet.php`), driven in one browser: the piplet
 * carries the invite and answer codes that `peer-pair.ts` carries by hand,
 * and everything after the codes travels the same WebRTC link. The piplet is
 * self-modifying, so the spec serves a throwaway copy, never the repository
 * file.
 *
 * Chromium only: only headless Chromium forms a loopback ICE pair. Skips
 * when no `php` is on the PATH: the signalling server is a PHP file, and its
 * absence is a host boundary.
 */

const pipletSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../signalling/piplet.php",
);

// A fixed port outlives the spec: a hard-killed run orphans its php server,
// and the orphan then answers the next run's requests. A freshly freed port
// keeps every run on its own server.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

test("connects two computers by session name", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "only headless Chromium can form a loopback ICE pair",
  );
  test.skip(
    spawnSync("php", ["--version"]).status !== 0,
    "the signalling piplet is a PHP file, and no php is on the PATH",
  );
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();

  const port = await freePort();
  const signallingUrl = `http://127.0.0.1:${port}/`;
  const directory = mkdtempSync(join(tmpdir(), "kandelo-signalling-"));
  const copy = join(directory, "piplet.php");
  writeFileSync(copy, readFileSync(pipletSource));
  const server = spawn("php", ["-S", `127.0.0.1:${port}`, copy], {
    stdio: "ignore",
  });
  const sharerContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50 && !ready; attempt++) {
      try {
        ready =
          (await fetch(`${signallingUrl}?session=readiness-probe`)).status
            === 404;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(ready, "the signalling piplet did not start").toBe(true);

    const sharer = await sharerContext.newPage();
    const viewer = await viewerContext.newPage();
    const query = `signalling=${encodeURIComponent(signallingUrl)}`;
    await sharer.goto(appUrl(`/?demo=shell&${query}`), {
      waitUntil: "domcontentloaded",
    });
    await viewer.goto(appUrl(`/?${query}`), { waitUntil: "domcontentloaded" });

    // A name outside the rule is refused on the computer, before any request.
    await openNetworkPopover(sharer);
    await sharer.fill("#knetwork-session", "Foo Bar");
    await sharer
      .getByRole("button", { name: "Host this session" })
      .click({ timeout: 120_000 });
    await expect(sharer.locator(".knetwork-status")).toContainText(
      "a session name is lowercase words separated by dashes",
    );

    let linked = false;
    for (let attempt = 0; attempt < 3 && !linked; attempt++) {
      // The computer holding the machine hosts the name; the empty one joins
      // it. Hosting again replaces the session, so a retry is the same two
      // clicks.
      await openNetworkPopover(sharer);
      await openNetworkPopover(viewer);
      // The codes are off the screen: the exchange the humans used to carry
      // is collapsed behind the by-hand fallback.
      await expect(sharer.locator("#knetwork-local")).toBeHidden();
      const host = sharer.getByRole("button", { name: "Host this session" });
      await expect(host).toBeVisible({ timeout: 120_000 });
      await sharer.fill("#knetwork-session", "foo-bar");
      await host.click();
      await expect(sharer.locator(".knetwork-status")).toContainText(
        'Hosting "foo-bar"',
        { timeout: 30_000 },
      );
      await viewer.fill("#knetwork-session", "foo-bar");
      await viewer.getByRole("button", { name: "Join this session" }).click();
      const settled = await Promise.all(
        [viewer, sharer].map((page) =>
          expect(networkButton(page))
            .toHaveClass(/is-connected/, { timeout: 30_000 })
            .then(() => true, () => false),
        ),
      );
      linked = settled.every(Boolean);
    }
    if (!linked) {
      await openNetworkPopover(sharer);
      await openNetworkPopover(viewer);
      const states = await Promise.all(
        [viewer, sharer].map((page) =>
          page.locator(".knetwork-status").innerText(),
        ),
      );
      // "No direct route" is the ICE boundary, not a transport defect: every
      // signalling or codec bug fails earlier with its own message.
      expect(
        states.some((state) => state.includes("no direct route")),
        `the link failed outside the ICE boundary: ${states.join(" | ")}`,
      ).toBe(true);
      test.skip(
        true,
        "no ICE route between two local contexts — on macOS, grant the "
        + "Playwright browser Local Network permission to run this spec",
      );
    }
  } finally {
    await viewerContext.close();
    await sharerContext.close();
    server.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});
