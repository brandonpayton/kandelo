import { expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    __migrationDemo: {
      state: () => string;
      linkState: () => string;
      hasInput: () => boolean;
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
async function expectTurnChangesView(
  page: Page,
  who: string,
): Promise<void> {
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
 * Count differing frame samples over one settling window, optionally
 * holding a key through it.
 */
async function measureFrameDiff(
  page: Page,
  key: string | null,
): Promise<number> {
  await page.evaluate(() => window.__migrationDemo.snapshotFrame());
  if (key) {
    await page.keyboard.down(key);
    await page.waitForTimeout(600);
    await page.keyboard.up(key);
    await page.waitForTimeout(1_500);
  } else {
    await page.waitForTimeout(2_100);
  }
  return page.evaluate(() => window.__migrationDemo.frameDiffCount());
}

/** The exact permission state: a watching tab has no keyboard attached. */
async function expectNoKeyboard(
  page: Page,
  who: string,
): Promise<void> {
  expect(
    await page.evaluate(() => window.__migrationDemo.hasInput()),
    `${who}: a watching tab must hold no keyboard`,
  ).toBe(false);
}

/**
 * Prove a keypress did NOT reach the game. Reliable only in a scene whose
 * own animation is bounded — the freshly started game facing the static
 * corridor. Once accumulated turns leave a monster in view, its acting
 * rewrites thousands of samples with no input at all, so later hops assert
 * the permission state through expectNoKeyboard instead.
 */
export async function expectSpectatorKeysDoNothing(
  page: Page,
  who: string,
): Promise<void> {
  await expectNoKeyboard(page, who);
  const idle = await measureFrameDiff(page, null);
  const keyed = await measureFrameDiff(page, "ArrowLeft");
  expect(
    keyed,
    `${who}: ArrowLeft must not turn the watched view (idle noise ${idle})`,
  ).toBeLessThan(Math.max(1_000, idle * 3 + 500));
}

/**
 * The tab must be rendering the other tab's machine live: frames present
 * and still changing (fbDOOM's status-bar animation runs even in a static
 * scene).
 */
export async function expectLiveMirror(
  page: Page,
  who: string,
): Promise<void> {
  await expect
    .poll(() => pixelSum(page), {
      timeout: 30_000,
      message: `${who}: mirror renders`,
    })
    .toBeGreaterThan(0);
  const mirrored = await pixelSum(page);
  await expect
    .poll(() => pixelSum(page), {
      timeout: 30_000,
      message: `${who}: mirror keeps updating`,
    })
    .not.toBe(mirrored);
}

/**
 * One handover hop: the taking tab asks, the yielding tab freezes and
 * reports it, and the restored machine must render fresh frames and hear
 * the keyboard in its new tab. The yielding tab keeps watching the same
 * machine live but loses the keyboard with it.
 */
export async function expectTakeover(
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
  await expectLiveMirror(yielding, `${who}: yielded tab`);
  await expectNoKeyboard(yielding, `${who}: yielded tab`);
  await expectTurnChangesView(taking, who);
}

/**
 * Boot fbDOOM on the page and enter a real game — menu, New Game, skill
 * confirm — so the scene is static without input and a turn is
 * attributable to the keyboard alone. No canvas click: starting a machine
 * must hand the keyboard over by itself.
 */
export async function startMachineWithGame(page: Page): Promise<void> {
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

  for (const key of ["Escape", "Enter", "Enter", "Enter"]) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(2_000);
  await expectTurnChangesView(page, "keeper");
}
