/**
 * Two Kandelo computers, connected in one browser.
 *
 * Two isolated contexts share no `BroadcastChannel`, so everything that
 * crosses between them travels the manually signalled WebRTC link exactly as
 * it would between two real computers. Connecting them is the same three
 * steps in every spec that needs a pair — the humans carry the invite and the
 * answer — so the steps live here rather than in each spec.
 *
 * Chromium only: only headless Chromium forms a loopback ICE pair.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export const appUrl = (path: string): string => {
  const baseUrl = process.env.KANDELO_TEST_BASE_URL;
  return baseUrl ? new URL(path, baseUrl).href : path;
};

/** The Network dock button, which reports the link whether or not it is open. */
export function networkButton(page: Page): Locator {
  return page.getByRole("button", { name: "Network", exact: true });
}

async function linkStatus(page: Page): Promise<string> {
  return page.locator(".knetwork-status").innerText();
}

/**
 * Show the Network popover, whatever state it is in.
 *
 * Adopting a machine closes it — the page reacts to the boot descriptor it is
 * now running — so a test that reads the popup after a handover cannot assume
 * the popover it opened earlier is still there.
 */
export async function openNetworkPopover(page: Page): Promise<void> {
  const button = networkButton(page);
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
  await expect(button).toHaveAttribute("aria-expanded", "true");
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

/**
 * Carry the invite and the answer between the two pages, as the humans do.
 *
 * The sharer initiates, the viewer answers, the sharer completes. The retry
 * is the one a human makes when the page reports a failed attempt. Skips the
 * test at the ICE boundary — no direct route between two local contexts is a
 * network limit, not a transport defect — and fails on anything else.
 *
 * Both popups are gone by the time this returns: the popup exists to buy a
 * connection, and it closes itself once there is one. The link is therefore
 * read from the dock button, which stays whether or not anything is open, and
 * a test that wants the status text opens the popup again for it.
 */
export async function connectPeers(
  sharer: Page,
  viewer: Page,
  skip: (reason: string) => void,
): Promise<void> {
  await openNetworkPopover(sharer);
  await openNetworkPopover(viewer);

  let invite = "";
  let answer = "";
  let linked = false;
  for (let attempt = 0; attempt < 3 && !linked; attempt++) {
    // The computer holding the machine invites; the empty one accepts, because
    // only a computer with a machine has anything to invite someone to. Which
    // of them can take the machine over is decided separately and keeps
    // changing: it follows the machine, not the invite.
    await openNetworkPopover(sharer);
    await openNetworkPopover(viewer);
    await sharer.getByRole("button", { name: "Create invite code" }).click();
    invite = await freshCode(sharer, invite);
    await viewer.fill("#knetwork-remote", invite);
    await viewer.getByRole("button", { name: "Answer invite" }).click();
    answer = await freshCode(viewer, answer);
    await sharer.fill("#knetwork-remote", answer);
    await sharer.getByRole("button", { name: "Complete connection" }).click();
    const settled = await Promise.all(
      [viewer, sharer].map((page) =>
        expect(networkButton(page))
          .toHaveClass(/is-connected/, { timeout: 30_000 })
          .then(() => true, () => false),
      ),
    );
    linked = settled.every(Boolean);
  }
  if (linked) return;

  await openNetworkPopover(sharer);
  await openNetworkPopover(viewer);
  const states = await Promise.all([viewer, sharer].map(linkStatus));
  // "No direct route" is the ICE boundary, not a transport defect: every
  // signalling or codec bug fails earlier with its own message.
  expect(
    states.some((state) => state.includes("no direct route")),
    `the link failed outside the ICE boundary: ${states.join(" | ")}`,
  ).toBe(true);
  skip(
    "no ICE route between two local contexts — on macOS, grant the "
    + "Playwright browser Local Network permission to run this spec",
  );
}

/**
 * Hide every dock popover that would swallow a click meant for a terminal.
 *
 * An open popover lays a dismiss layer across the page (`Dock.tsx`,
 * `kdock-popover-dismiss-layer`), and that layer takes the pointer-down: the
 * click closes the popover instead of focusing the terminal under it. A person
 * clicks again and gets on with it; a test clicks once, so it has to clear the
 * popovers first.
 *
 * The guide is here and not only the network popup because adopting a machine
 * opens it: the taker is running a demo it did not launch, so the page shows
 * that demo's guide over the terminal the machine arrived with.
 *
 * Neither popover is tied to the link, so closing them changes nothing about
 * what is shared.
 */
export async function closeDockPopovers(pages: Page[]): Promise<void> {
  for (const page of pages) {
    for (const name of ["Network", "Guide"]) {
      const button = page.getByRole("button", { name, exact: true });
      // The guide button is absent on a machine with no guide at all.
      if ((await button.count()) === 0) continue;
      if ((await button.getAttribute("aria-expanded")) === "true") {
        await button.click();
      }
      await expect(button).toHaveAttribute("aria-expanded", "false");
    }
  }
}

export async function terminalText(
  page: Page,
  selector: string,
): Promise<string> {
  return page
    .locator(`${selector} .xterm-rows`)
    .first()
    .evaluate((node) => node.textContent ?? "");
}

/**
 * Type into a terminal on a machine that has just arrived by handover.
 *
 * Focuses the emulator's input directly instead of clicking the terminal. A
 * taker settles its boot descriptor and then loads the arriving image's demo
 * guide, and `App.tsx` opens that guide once per descriptor and title, so it
 * can open after a test has already cleared the popovers. An open popover lays
 * a dismiss layer over the page (`Dock.tsx`, `kdock-popover-dismiss-layer`)
 * that takes the pointer-down: the click closes the guide and focuses nothing,
 * and every keystroke after it goes to the page instead of the shell. A person
 * sees the guide and clicks again; a test cannot win that race.
 */
export async function typeIntoTerminal(
  page: Page,
  selector: string,
  line: string,
): Promise<void> {
  await page.locator(`${selector} .xterm-helper-textarea`).first().focus();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}
