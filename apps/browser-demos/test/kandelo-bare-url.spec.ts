import { expect, test } from "@playwright/test";

/**
 * A Kandelo page holds a machine only once something asks for one. A bare
 * URL asks for nothing, so it renders the empty state and spends no image
 * download on a choice the visitor never made.
 *
 * The second test is the control: it proves the gate selects on the request
 * rather than disabling boot, which the first test alone cannot tell apart.
 */

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

test("holds no machine for a bare URL", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

  await expect(page.locator(".kempty")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".kdock-status-text")).toHaveAttribute(
    "data-status",
    "idle",
  );
  await expect(page.locator(".kdock-status-text")).toContainText("No machine");

  // Beside "No machine", a machine name is a contradiction, so the dock
  // falls back to the product name.
  await expect(page.locator(".kdock-status-title")).toHaveText("Kandelo");
});

test("boots the machine a demo id asks for", async ({ page }) => {
  test.setTimeout(300_000);

  await page.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });

  await expect(page.locator(".kdock-status-text")).not.toHaveAttribute(
    "data-status",
    "idle",
    { timeout: 120_000 },
  );
  await expect(page.locator(".kempty")).toHaveCount(0);
});
