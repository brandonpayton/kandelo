import { expect, test } from "@playwright/test";

import { doomSharewareWad } from "../../../host/test/support/doom-shareware";
import {
  expectLiveMirror,
  expectSpectatorKeysDoNothing,
  expectTakeover,
  startMachineWithGame,
} from "./support/migration-demo";

test("hands a running fbDOOM machine from one tab to another", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();
  // The demo page fetches the same pinned shareware IWAD; this Node-side
  // probe skips the test on an offline machine instead of failing it.
  try {
    await doomSharewareWad();
  } catch {
    test.skip(true, "doom1.wad unavailable (offline) — the demo can't run");
    return;
  }

  await page.goto(new URL("/pages/migration/", baseURL!).href);
  await startMachineWithGame(page);

  const taker = await context.newPage();
  await taker.goto(new URL("/pages/migration/", baseURL!).href);

  // A tab that merely opens the page watches the running game live and has
  // no say in it — only "Take over" grants the keyboard.
  await taker.waitForFunction(
    () => window.__migrationDemo?.state().startsWith("Watching"),
    undefined,
    { timeout: 30_000 },
  );
  await expectLiveMirror(taker, "watcher before takeover");
  await expectSpectatorKeysDoNothing(taker, "watcher before takeover");

  // The machine moves between the tabs as often as asked: over, back, and
  // over again. Every taker re-offers, and a tab that handed over re-arms
  // its take button, so the third hop proves one page can take repeatedly.
  await expectTakeover(taker, page, "taker");
  await expectTakeover(page, taker, "keeper taking back");
  await expectTakeover(taker, page, "taker taking again");
});
