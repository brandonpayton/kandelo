import { expect, test, type Page } from "@playwright/test";

/**
 * One machine, running on both computers at once.
 *
 * A mirror sends the user's pixels and the viewer paints them, so the viewer's
 * computer runs nothing. Replication sends the user's decisions instead: the
 * viewer restores the user's checkpoint into a machine of its own and runs it
 * on the values the user's host produced, so the second browser renders a
 * machine it did not start rather than a picture of one.
 *
 * That is the claim these tests make. Not that the two look alike — a mirror
 * already achieves that — but that the second computer is running the
 * processes, from the state the first one was in, on the first one's clock.
 * The exact-equality half of that claim is
 * `host/test/replication/live-join.test.ts`, which compares what the two
 * machines print reading by reading. Here it is the product surface: which
 * computer holds a machine, which one may type, and what each is told it is
 * looking at.
 *
 * Replication starts on its own, as soon as the link opens. There is nothing
 * to press because there is nothing to decide: the computer holding a machine
 * is the user, and the computer holding none is the viewer.
 *
 * Chromium only, for the same reason as `kandelo-network-share.spec.ts`: only
 * headless Chromium forms a loopback ICE pair.
 */

import { distinctColors } from "./support/canvas";
import {
  appUrl,
  closeDockPopovers,
  connectPeers,
  networkButton,
  openNetworkPopover,
  terminalText,
  typeIntoTerminal,
} from "./support/peer-pair";

/** The take-over control, offered only to a computer that may use it. */
function takeButton(page: Page) {
  return page.getByRole("button", { name: "Take over this machine" });
}

/**
 * Wait until this page is running a replica of the other computer's machine.
 *
 * Read from the dock rather than from a terminal on the page: the mirrored
 * terminal a viewer watches and the terminal of a machine it holds are the
 * same emulator in the same `.kshell-host`, so their presence says nothing
 * about which of the two this is. The dock says both halves — a machine is
 * running here, and this computer is still the viewer — and no shared surface
 * is left to watch.
 */
async function expectReplica(page: Page): Promise<void> {
  await expect(page.locator(".kdock-status-text"))
    .toHaveAttribute("data-status", "running", { timeout: 300_000 });
  await expect(page.locator(".kdock-status"))
    .toHaveAttribute("data-role", "viewer");
  await expect(page.locator(".kshared-machine")).toHaveCount(0);
}

/**
 * Open a terminal on a fresh machine and wait for its shell.
 *
 * A machine with no PTY session carries no terminal into a checkpoint, so a
 * replica of it would have nothing to show and the test would be measuring an
 * empty screen rather than a running one.
 */
async function openShell(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Terminal", exact: true })
    .click({ timeout: 60_000 });
  await expect(page.locator(".kshell-host .xterm-rows").first())
    .toBeVisible({ timeout: 120_000 });
  await expect
    .poll(() => terminalText(page, ".kshell-host"), { timeout: 120_000 })
    .toContain("$");
}

test("runs the user's machine on the computer that was watching it", async ({
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

  const userContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const user = await userContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await user.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await openShell(user);

    // Something the user's machine did before the two computers met. It is in
    // the state the viewer adopts, so finding it on the viewer is finding the
    // user's machine there rather than a second one that looks like it.
    const before = `kandelo-before-${Date.now().toString(36)}`;
    await closeDockPopovers([user]);
    await typeIntoTerminal(user, ".kshell-host", `echo ${before}`);
    await expect
      .poll(() => terminalText(user, ".kshell-host"), { timeout: 60_000 })
      .toContain(before);

    await connectPeers(user, viewer, (reason) => test.skip(true, reason));

    // The viewer ends up holding a machine, with no shared surface left to
    // watch. Nothing was pressed to make that happen: a computer that connects
    // to a machine is a computer that runs it.
    await expectReplica(viewer);

    // And what it holds is the user's machine, carried across as state rather
    // than redrawn as pixels: the line the user's shell printed before the two
    // computers had ever met is on the viewer's own screen.
    await expect
      .poll(() => terminalText(viewer, ".kshell-host"), { timeout: 120_000 })
      .toContain(before);

    // Both computers are told which of them they are. The viewer runs a
    // machine and still cannot type into it, which is the one thing a summary
    // derived from "does this computer hold a machine" would get backwards.
    await openNetworkPopover(user);
    await openNetworkPopover(viewer);
    await expect(viewer.locator(".knetwork-status"))
      .toContainText("This computer is running a copy of it", {
        timeout: 30_000,
      });
    await expect(user.locator(".knetwork-status"))
      .toContainText("The other computer is running a copy of this machine", {
        timeout: 30_000,
      });

    // The dock says the same thing in one word, which is what the read-only
    // badge on the viewer's terminal is derived from.
    await expect(viewer.locator(".kdock-status"))
      .toHaveAttribute("data-role", "viewer");
    await expect(user.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user");

    // A replica is a copy of one machine, not a second machine. The user is
    // offered no way to take it, because taking it would leave two copies of
    // one state with nothing keeping them one. Take-over still runs the other
    // way, and still means the user's machine.
    await expect(takeButton(user)).toHaveCount(0);
    await expect(takeButton(viewer)).toHaveCount(1);
  } finally {
    await viewerContext.close();
    await userContext.close();
  }
});

test("gives the viewer the user's shell, not a shell of its own", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "only headless Chromium can form a loopback ICE pair",
  );
  test.setTimeout(420_000);
  expect(baseURL).toBeTruthy();

  const userContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const user = await userContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await user.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await openShell(user);

    // Connected while the user's shell sits at a prompt, and touched only
    // afterwards. A machine is read by freezing it and a process that makes no
    // syscall reaches no freeze hook, so this is the order in which the first
    // join is refused and the replica arrives on a later attempt — at the very
    // moment the person at the other computer types. What arrives then must be
    // the user's shell. A second shell of the viewer's own would look almost
    // the same on screen, and would be a different machine.
    await connectPeers(user, viewer, (reason) => test.skip(true, reason));
    await closeDockPopovers([user, viewer]);
    const typed = `kandelo-after-${Date.now().toString(36)}`;
    await typeIntoTerminal(user, ".kshell-host", `echo ${typed}`);
    await expect
      .poll(() => terminalText(user, ".kshell-host"), { timeout: 60_000 })
      .toContain(typed);

    await expectReplica(viewer);
    await expect
      .poll(() => terminalText(viewer, ".kshell-host"), { timeout: 180_000 })
      .toContain(typed);

    // The guide belongs to a launch. This computer launched nothing — it
    // connected to a machine — so the replica arriving must not open one
    // over the shell the person was already watching.
    await expect(viewer.locator(".kdemo")).toHaveCount(0);

    // And the viewer cannot answer it. A keystroke here reaches no log, so the
    // machine the user holds would never make the decision this one just made.
    const refused = `kandelo-refused-${Date.now().toString(36)}`;
    await typeIntoTerminal(viewer, ".kshell-host", `echo ${refused}`);
    await viewer.waitForTimeout(5_000);
    expect(await terminalText(viewer, ".kshell-host")).not.toContain(refused);
    expect(await terminalText(user, ".kshell-host")).not.toContain(refused);
  } finally {
    await viewerContext.close();
    await userContext.close();
  }
});

test("follows the user to the demo they launch next", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "only headless Chromium can form a loopback ICE pair",
  );
  test.setTimeout(600_000);
  expect(baseURL).toBeTruthy();

  const userContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const user = await userContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await user.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await openShell(user);
    await connectPeers(user, viewer, (reason) => test.skip(true, reason));
    await expectReplica(viewer);
    await expect(viewer.locator(".kdock-status-title")).not.toHaveText("fbDOOM");

    // Launching a demo destroys the machine the viewer is a copy of and boots
    // a different one in its place. The page boots it where it stands rather
    // than navigating, because navigating would drop the link — so nothing
    // about the viewer's own computer changes, and a viewer that watched only
    // its own status would go on running a machine that exists nowhere.
    await closeDockPopovers([user, viewer]);
    await user.getByRole("button", { name: "New", exact: true }).click();
    await user.getByRole("row", { name: "Launch fbDOOM" })
      .getByRole("button", { name: "Launch" }).click();
    await expect(user.locator(".kdock-status-text"))
      .toHaveAttribute("data-status", "running", { timeout: 300_000 });
    await expect(user.locator(".kdock-status-title")).toHaveText("fbDOOM");
    await expect(user.locator(".kdock-status")).toHaveAttribute("data-role", "user");

    // The viewer joins the machine that replaced the one it was running, and
    // is the viewer of that one on the same terms: it holds a machine, it is
    // told it holds a copy, and there is no mirror pane to watch.
    await expect(viewer.locator(".kdock-status-title"))
      .toHaveText("fbDOOM", { timeout: 300_000 });
    await expectReplica(viewer);

    // And it is running fbDOOM rather than being shown a picture of one: the
    // pixels on this screen were painted by this computer, from the decisions
    // the other one made.
    const viewerCanvas = viewer.locator("canvas.kframebuffer-canvas").first();
    await expect(viewerCanvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => distinctColors(viewerCanvas), {
      timeout: 180_000,
      intervals: [1_000, 2_000, 3_000],
    }).toBeGreaterThan(4);
  } finally {
    await viewerContext.close();
    await userContext.close();
  }
});

test("gives the machine to the viewer, and a replica back to the user", async ({
  browser,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "only headless Chromium can form a loopback ICE pair",
  );
  test.setTimeout(420_000);
  expect(baseURL).toBeTruthy();

  const userContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  const user = await userContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await user.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await openShell(user);
    await connectPeers(user, viewer, (reason) => test.skip(true, reason));
    await expectReplica(viewer);

    // Taking the machine over replaces the viewer's replica with the machine
    // itself. The replica was a copy kept the same by the log; what arrives
    // now is the state, and this computer decides for it from here.
    await openNetworkPopover(viewer);
    await takeButton(viewer).click();
    await closeDockPopovers([user, viewer]);
    await expect(viewer.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user", { timeout: 300_000 });
    // Running, not merely booting. A machine only answers a request to
    // replicate it once it is one, so the computer that gave it up is waiting
    // for this before it can start following it again.
    await expect(viewer.locator(".kdock-status-text"))
      .toHaveAttribute("data-status", "running", { timeout: 300_000 });

    // Which makes the two computers each other's opposite, without either of
    // them re-deciding anything: the roles follow the machine. The computer
    // that gave it up is running a replica of it now, so it holds a machine
    // again and still may not type into one.
    //
    // Typing first because a machine is read by freezing it, and a process
    // that makes no syscall reaches no freeze hook: a shell sitting at a
    // prompt refuses to be read until something wakes it. The viewer asks
    // again on its own, and this is the keystroke that lets the next attempt
    // succeed — the same thing that would make it succeed for a person.
    const typed = `kandelo-after-${Date.now().toString(36)}`;
    await typeIntoTerminal(viewer, ".kshell-host", `echo ${typed}`);
    await expect
      .poll(() => terminalText(viewer, ".kshell-host"), { timeout: 90_000 })
      .toContain(typed);
    await expectReplica(user);

    // And the keyboard went with the machine: what the computer that took it
    // typed above reached a shell. The other one is offered the take, not the
    // typing.
    await openNetworkPopover(user);
    await openNetworkPopover(viewer);
    await expect(takeButton(user)).toHaveCount(1);
    await expect(takeButton(viewer)).toHaveCount(0);
    await expect(networkButton(user)).toHaveClass(/is-connected/);
  } finally {
    await viewerContext.close();
    await userContext.close();
  }
});
