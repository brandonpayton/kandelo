import { expect, test, type Page } from "@playwright/test";

/**
 * Sharing a Kandelo terminal with another computer, driven in one browser:
 * two isolated contexts share no BroadcastChannel, so everything that
 * crosses between them travels the manually signalled WebRTC link exactly
 * as it would between two real computers.
 *
 * The viewer holds no machine of its own. It renders the sharer's terminal
 * from the bytes that terminal produced, and what it types reaches the
 * sharer's shell — which is the whole point of sharing text rather than
 * pixels.
 *
 * Chromium only, for the same reason as `migration-remote.spec.ts`: only
 * headless Chromium forms a loopback ICE pair.
 */

const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

async function linkStatus(page: Page): Promise<string> {
  return page.locator(".knetwork-status").innerText();
}

async function freshCode(page: Page, previous: string): Promise<string> {
  await page.waitForFunction(
    (before) => {
      const field = document.getElementById(
        "knetwork-local",
      ) as HTMLTextAreaElement | null;
      const value = field?.value ?? "";
      return value.startsWith("kandelo1:") && value !== before;
    },
    previous,
    { timeout: 30_000 },
  );
  return page.inputValue("#knetwork-local");
}

async function terminalText(page: Page, selector: string): Promise<string> {
  return page
    .locator(`${selector} .xterm-rows`)
    .first()
    .evaluate((node) => node.textContent ?? "");
}

async function terminalRows(page: Page, selector: string): Promise<number> {
  return page.locator(`${selector} .xterm-rows > div`).count();
}

test("shares a running machine's terminal with a computer that has none", async ({
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

  const sharerContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const sharer = await sharerContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await sharer.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

    // The sharer needs a terminal open: a machine with no PTY session has
    // nothing to share, and the popup says so rather than pretending.
    await sharer.getByRole("button", { name: "Terminal", exact: true })
      .click({ timeout: 60_000 });
    await expect(sharer.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    await sharer.getByRole("button", { name: "Network", exact: true }).click();
    await viewer.getByRole("button", { name: "Network", exact: true }).click();

    // The humans carry the codes. The viewer initiates, the sharer answers,
    // the viewer completes — the retry is the one a human makes when the
    // page reports a failed attempt.
    let invite = "";
    let answer = "";
    let linked = false;
    for (let attempt = 0; attempt < 3 && !linked; attempt++) {
      await viewer.getByRole("button", { name: "Create invite code" }).click();
      invite = await freshCode(viewer, invite);
      await sharer.fill("#knetwork-remote", invite);
      await sharer.getByRole("button", { name: "Answer invite" }).click();
      answer = await freshCode(sharer, answer);
      await viewer.fill("#knetwork-remote", answer);
      await viewer.getByRole("button", { name: "Complete connection" }).click();
      const settled = await Promise.all(
        [viewer, sharer].map((page) =>
          page.waitForFunction(
            () =>
              (document.querySelector(".knetwork-status")?.textContent ?? "")
                .includes("Connected to the other computer."),
            undefined,
            { timeout: 30_000 },
          ).then(() => true, () => false),
        ),
      );
      linked = settled.every(Boolean);
    }
    if (!linked) {
      const states = await Promise.all([viewer, sharer].map(linkStatus));
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

    // The sharer reports what it is actually doing.
    await expect(sharer.locator(".knetwork-status"))
      .toContainText("Sharing this machine's terminals.", { timeout: 30_000 });

    // The viewer shows the shared terminal instead of the empty state: it
    // holds no machine, and the surface says so.
    await expect(viewer.locator(".kshared-terminal")).toBeVisible();
    await expect(viewer.locator(".kshared-terminal-head"))
      .toContainText("Terminal on the other computer", { timeout: 60_000 });

    // The viewer renders the sharer's machine, so it must render it at the
    // sharer's size. A session reports its geometry only once an emulator has
    // attached, and the viewer skips a zero, so a viewer left at xterm's
    // default would replay the sharer's byte log at the wrong width and split
    // that shell's in-place prompt redraws into separate visible prompts.
    const sharerRows = await terminalRows(sharer, ".kshell-host");
    expect(sharerRows).toBeGreaterThan(0);
    await expect
      .poll(() => terminalRows(viewer, ".kshared-terminal"), { timeout: 60_000 })
      .toBe(sharerRows);

    // An open popover lays a dismiss layer across the page, which swallows
    // the pointer-down that would focus a terminal. Close both with the
    // toggle that opened them; the link is not tied to the popover.
    for (const page of [sharer, viewer]) {
      const networkButton = page.getByRole("button", {
        name: "Network",
        exact: true,
      });
      await networkButton.click();
      await expect(networkButton).toHaveAttribute("aria-expanded", "false");
    }

    // Text the sharer's machine printed reaches the viewer.
    const fromSharer = `kandelo-share-${Date.now().toString(36)}`;
    await sharer.locator(".kshell-host").first().click();
    await sharer.keyboard.type(`echo ${fromSharer}`);
    await sharer.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(viewer, ".kshared-terminal"), { timeout: 90_000 })
      .toContain(fromSharer);

    // What the viewer types reaches the sharer's shell, so the terminal is
    // shared rather than merely shown.
    const fromViewer = `kandelo-typed-${Date.now().toString(36)}`;
    await viewer.locator(".kshared-terminal-host").click();
    await viewer.keyboard.type(`echo ${fromViewer}`);
    await viewer.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(sharer, ".kshell-host"), { timeout: 90_000 })
      .toContain(fromViewer);
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});
