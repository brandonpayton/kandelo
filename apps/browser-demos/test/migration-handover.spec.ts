import { expect, test, type Page } from "@playwright/test";

import { doomSharewareWad } from "../../../host/test/support/doom-shareware";

declare global {
  interface Window {
    __migrationDemo: {
      state: () => string;
      framePixelSum: () => number;
      snapshotFrame: () => number;
      frameDiffCount: () => number;
    };
  }
}

function pixelSum(page: Page): Promise<number> {
  return page.evaluate(() => window.__migrationDemo.framePixelSum());
}

/**
 * Prove a keypress reached the game: snapshot the frame, turn, and count
 * differing samples. A turn rewrites the whole viewport (thousands of
 * samples), while idle animation touches only the status-bar face (tens),
 * so the threshold separates "the game acted on the key" from "the game
 * merely kept rendering".
 */
async function expectTurnChangesView(page: Page, who: string): Promise<void> {
  await page.evaluate(() => window.__migrationDemo.snapshotFrame());
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(600);
  await page.keyboard.up("ArrowLeft");
  await expect
    .poll(
      () => page.evaluate(() => window.__migrationDemo.frameDiffCount()),
      { timeout: 10_000, message: `${who}: ArrowLeft turns the view` },
    )
    .toBeGreaterThan(500);
}

/**
 * One handover hop: the taking tab asks, the yielding tab freezes and
 * reports it, and the restored machine must render fresh frames and hear
 * the keyboard in its new tab.
 */
async function expectTakeover(
  taking: Page,
  yielding: Page,
  who: string,
): Promise<void> {
  await taking.click("#take");
  await taking.waitForFunction(
    () => window.__migrationDemo?.state().includes("taken over"),
    undefined,
    { timeout: 120_000 },
  );
  await yielding.waitForFunction(
    () => window.__migrationDemo?.state().startsWith("Handed over"),
    undefined,
    { timeout: 30_000 },
  );
  await expect
    .poll(() => pixelSum(taking), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const restoredFrame = await pixelSum(taking);
  await expect
    .poll(() => pixelSum(taking), { timeout: 30_000 })
    .not.toBe(restoredFrame);
  await expectTurnChangesView(taking, who);
}

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
  await page.click("#start");
  await page.waitForFunction(
    () => window.__migrationDemo?.state().startsWith("Running."),
    undefined,
    { timeout: 120_000 },
  );
  // The attract demo animates: the frame must exist and keep changing.
  await expect
    .poll(() => pixelSum(page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  const keeperFrame = await pixelSum(page);
  await expect
    .poll(() => pixelSum(page), { timeout: 30_000 })
    .not.toBe(keeperFrame);

  // Start a real game — menu, New Game, skill confirm — so the scene is
  // static without input and a turn is attributable to the keyboard alone.
  // No canvas click: starting a machine must hand the keyboard over by
  // itself.
  for (const key of ["Escape", "Enter", "Enter", "Enter"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2_000);
  await expectTurnChangesView(page, "keeper");

  const taker = await context.newPage();
  await taker.goto(new URL("/pages/migration/", baseURL!).href);

  // The machine moves between the tabs as often as asked: over, back, and
  // over again. Every taker re-offers, and a tab that handed over re-arms
  // its take button, so the third hop proves one page can take repeatedly.
  await expectTakeover(taker, page, "taker");
  await expectTakeover(page, taker, "keeper taking back");
  await expectTakeover(taker, page, "taker taking again");
});
