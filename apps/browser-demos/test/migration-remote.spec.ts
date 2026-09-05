import { expect, test, type Page } from "@playwright/test";

import { doomSharewareWad } from "../../../host/test/support/doom-shareware";
import {
  expectLiveMirror,
  expectSpectatorKeysDoNothing,
  expectTakeover,
  startMachineWithGame,
} from "./support/migration-demo";

/**
 * The two-computer demo, driven in one browser: two isolated contexts share
 * no BroadcastChannel, so everything that crosses between them — mirror
 * frames, the take request, the checkpoint — crosses the manually signalled
 * WebRTC link, exactly as it would between two real computers on a LAN.
 *
 * Chromium only: a headless loopback ICE pair needs host candidates that
 * actually deliver. Playwright's Firefox emits them but macOS Local Network
 * permission drops its UDP (no prompt without a UI), and Playwright's WebKit
 * gathers no host candidates at all without a capture permission. Both
 * browsers connect between real computers, where mDNS candidates resolve
 * through the OS responder.
 */
test("hands a running fbDOOM machine between two isolated contexts over WebRTC", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "only headless Chromium can form a loopback ICE pair",
  );
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();
  try {
    await doomSharewareWad();
  } catch {
    test.skip(true, "doom1.wad unavailable (offline) — the demo can't run");
    return;
  }

  const keeperContext = await browser.newContext();
  const watcherContext = await browser.newContext();
  const keeper = await keeperContext.newPage();
  const watcher = await watcherContext.newPage();
  try {
    await keeper.goto(new URL("/pages/migration/", baseURL!).href);
    await watcher.goto(new URL("/pages/migration/", baseURL!).href);
    await keeper.click("#connect > summary");
    await watcher.click("#connect > summary");
    await startMachineWithGame(keeper);

    // The watching computer initiates: create the invite, carry it to the
    // keeper, carry the answer back, complete. The test plays the human
    // that the manual signalling deliberately requires — including the
    // retry a human makes when the page reports a failed connection. On
    // macOS the Local Network permission silently denies the headless
    // browser's own-LAN-IP UDP, killing the host candidate pair, and the
    // remaining srflx pair hairpins through the local router, which is
    // unreliable — so attempts flake even in Chromium.
    const freshCode = async (page: Page, previous: string) => {
      await page.waitForFunction(
        (before) => {
          const value = (
            document.getElementById("local-signal") as HTMLTextAreaElement
          ).value;
          return value.startsWith("kandelo1:") && value !== before;
        },
        previous,
        { timeout: 30_000 },
      );
      return page.inputValue("#local-signal");
    };
    let invite = "";
    let answer = "";
    let linked = false;
    for (let attempt = 0; attempt < 3 && !linked; attempt++) {
      await watcher.click("#invite-create");
      invite = await freshCode(watcher, invite);
      await keeper.fill("#remote-signal", invite);
      await keeper.click("#invite-answer");
      answer = await freshCode(keeper, answer);
      await watcher.fill("#remote-signal", answer);
      await watcher.click("#invite-complete");
      const settled = await Promise.all(
        [watcher, keeper].map((page) =>
          page.waitForFunction(
            () => window.__migrationDemo?.linkState().startsWith("Connected"),
            undefined,
            { timeout: 30_000 },
          ).then(() => true, () => false),
        ),
      );
      linked = settled.every(Boolean);
    }
    if (!linked) {
      const states = await Promise.all(
        [watcher, keeper].map((page) =>
          page.evaluate(() => window.__migrationDemo.linkState()),
        ),
      );
      // "No direct route" is the ICE boundary, not a transport defect:
      // every signalling or codec bug fails earlier with its own message.
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

    // Spectating crosses the network: the watching computer renders the
    // game live, holds no keyboard, and its keys move nothing.
    await watcher.waitForFunction(
      () => window.__migrationDemo?.state().startsWith("Watching"),
      undefined,
      { timeout: 30_000 },
    );
    await expectLiveMirror(watcher, "remote watcher");
    await expectSpectatorKeysDoNothing(watcher, "remote watcher");

    // The whole machine crosses the link and comes back; each yielded side
    // keeps watching live without a keyboard.
    await expectTakeover(watcher, keeper, "remote taker");
    await expectTakeover(keeper, watcher, "keeper taking back");
  } finally {
    await watcherContext.close();
    await keeperContext.close();
  }
});
