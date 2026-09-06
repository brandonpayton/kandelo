import { expect, test, type Locator } from "@playwright/test";

/**
 * Sharing a Kandelo machine with another computer, driven in one browser:
 * two isolated contexts share no BroadcastChannel, so everything that
 * crosses between them travels the manually signalled WebRTC link exactly
 * as it would between two real computers.
 *
 * A connected viewer ends up *running* the other computer's machine — a
 * replica, restored from its checkpoint and driven by its decision log —
 * because replication starts on its own the moment the link opens. The
 * mirror is the bridge and the fallback, not the destination: the sharer's
 * terminal bytes and screen pixels are what the viewer watches while the
 * replica is still being captured, transferred, and booted, and what it
 * keeps watching if the machine cannot be captured. These tests pin that
 * arrangement: the bridge appears first, the replica replaces it, the
 * take-over moves the machine itself, and what a person made on one
 * computer is on the other one afterwards.
 *
 * What a replica is — one machine, same state, same decisions, read-only
 * keyboard — is `kandelo-machine-replication.spec.ts`. Here it is the
 * sharing surface around it.
 *
 * Chromium only, for the same reason as `migration-remote.spec.ts`: only
 * headless Chromium forms a loopback ICE pair.
 */

import { distinctColors } from "./support/canvas";
import {
  appUrl,
  closeDockPopovers,
  connectPeers,
  expectReplica,
  openNetworkPopover,
  takeOverButton,
  terminalText,
  typeIntoTerminal,
} from "./support/peer-pair";

test("bridges the viewer over the shared terminal until its replica runs", async ({
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
  // Everything the watching computer asks the network for, from before it
  // loads. Used below to show that it fetches the machine's image while it is
  // still only watching.
  const viewerRequests: string[] = [];
  viewer.on("request", (request) => viewerRequests.push(request.url()));
  try {
    await sharer.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

    await sharer.getByRole("button", { name: "Terminal", exact: true })
      .click({ timeout: 60_000 });
    await expect(sharer.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));

    // The bridge, before the replica: the sharer's terminal bytes are on this
    // screen long before a checkpoint could have crossed, so the person who
    // connected is watching the machine rather than a spinner. This is the
    // mirror, and it is transient.
    await expect(viewer.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 60_000 });
    await expect(viewer.locator(".kempty-peer-note")).toHaveCount(0);

    // The watching computer loads the machine's image before anyone asks it
    // to: a replica boots the same image, and without the prefetch the whole
    // download would sit between connecting and the replica appearing.
    // Matched on the image bytes, not on any URL with "vfs" in it: the dev
    // server also serves a module graph full of them. `.vfs.zst` without
    // Vite's `?import` suffix is the image itself.
    await expect
      .poll(
        () =>
          viewerRequests.filter(
            (url) => url.includes(".vfs.zst") && !url.includes("?import"),
          ).length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    // The replica replaces the bridge. From here the viewer is running the
    // machine; no shared surface is left to watch.
    await expectReplica(viewer);

    // And the sharer is told the arrangement changed: it is no longer
    // sending a surface to a watcher, the other computer runs a copy.
    await openNetworkPopover(sharer);
    await expect(sharer.locator(".knetwork-status"))
      .toContainText("The other computer is running a copy of this machine", {
        timeout: 30_000,
      });
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

test("replicates a machine that shares no surface at all", async ({
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
    // A machine with no surface open. The shell demo attaches a terminal as
    // it boots; the nginx demo boots a service and opens nothing, so the
    // mirror has nothing to bridge with — there are no terminal bytes and no
    // screen pixels to send. Replication does not care: it moves the
    // machine's state, not a surface, so this is the machine that shows the
    // difference.
    await sharer.goto(appUrl("/?demo=nginx"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));

    // The viewer ends up running a copy of the service, and the landing
    // page's waiting note is gone: this computer is not waiting for a
    // surface, it holds the machine.
    await expectReplica(viewer);
    await expect(viewer.locator(".kempty-peer-note")).toHaveCount(0);
    await expect(viewer.locator(".kshared-terminal")).toBeHidden();
    await expect(viewer.locator(".kshared-framebuffer")).toBeHidden();
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

test("bridges a running fbDOOM's pixels until its replica paints its own", async ({
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
    await sharer.goto(appUrl("/?demo=doom"), { waitUntil: "domcontentloaded" });
    if (await sharer.locator("vite-error-overlay").count()) {
      test.skip(true, "Required binary not built - Vite import error");
    }
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

    // fbDOOM must be painting before there is a screen to share.
    const sharerCanvas = sharer.locator("canvas.kframebuffer-canvas").first();
    await expect(sharerCanvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => distinctColors(sharerCanvas), {
      timeout: 120_000,
      intervals: [1_000, 2_000, 3_000],
    }).toBeGreaterThan(4);

    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));

    // The bridge: fbDOOM writes to /dev/fb0 rather than mapping it, so the
    // mirror has a pixel stream to forward while the replica is on its way.
    await expect(viewer.locator(".kshared-framebuffer"))
      .toBeVisible({ timeout: 90_000 });

    // The replica replaces it, and from here the pixels on this screen were
    // painted by this computer, from the decisions the other one made.
    await expectReplica(viewer);
    const viewerCanvas = viewer.locator("canvas.kframebuffer-canvas").first();
    await expect(viewerCanvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => distinctColors(viewerCanvas), {
      timeout: 180_000,
      intervals: [1_000, 2_000, 3_000],
    }).toBeGreaterThan(4);

    // Live, not one adopted frame: DOOM's demo loop keeps playing, so the
    // replica's pixels keep changing.
    const firstFrame = await canvasSignature(viewerCanvas);
    await expect
      .poll(() => canvasSignature(viewerCanvas), { timeout: 60_000 })
      .not.toBe(firstFrame);
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

/**
 * The whole handover, over a real peer connection, on a machine nobody has
 * reshaped for the test: a login shell in `wait4` and fbDOOM painting.
 *
 * The taker is already running a replica when it takes: replication started
 * at connect. Taking replaces the copy with the machine itself — this
 * computer decides for it from here — and the computer that gave it up
 * starts following it the other way round.
 */
test("moves a running fbDOOM to the computer that was watching it", async ({
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

  const keeperContext = await browser.newContext();
  const takerContext = await browser.newContext();
  const keeper = await keeperContext.newPage();
  const taker = await takerContext.newPage();
  try {
    await keeper.goto(appUrl("/?demo=doom"), { waitUntil: "domcontentloaded" });
    if (await keeper.locator("vite-error-overlay").count()) {
      test.skip(true, "Required binary not built - Vite import error");
    }
    await taker.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

    const keeperCanvas = keeper.locator("canvas.kframebuffer-canvas").first();
    await expect(keeperCanvas).toBeVisible({ timeout: 180_000 });
    await expect.poll(() => distinctColors(keeperCanvas), {
      timeout: 120_000,
      intervals: [1_000, 2_000, 3_000],
    }).toBeGreaterThan(4);

    await connectPeers(keeper, taker, (reason) => test.skip(true, reason));
    await expectReplica(taker);

    // The take sits with the link's other controls, in the network popup the
    // connection was made in, and only the computer running the copy is
    // offered it: a keeper cannot push its machine away.
    await openNetworkPopover(keeper);
    await openNetworkPopover(taker);
    await expect(takeOverButton(keeper)).toHaveCount(0);
    await takeOverButton(taker).click();
    await closeDockPopovers([keeper, taker]);

    // The machine itself arrives, and this computer decides for it now.
    await expect(taker.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user", { timeout: 300_000 });
    await expect(taker.locator(".kdock-status-text"))
      .toHaveAttribute("data-status", "running", { timeout: 300_000 });

    // The game carries on from the frame it was frozen on, in the browser
    // that took it. A machine that arrived dead would paint one still frame.
    const takerCanvas = taker.locator("canvas.kframebuffer-canvas").first();
    await expect(takerCanvas).toBeVisible({ timeout: 60_000 });
    const firstFrame = await canvasSignature(takerCanvas);
    await expect
      .poll(() => canvasSignature(takerCanvas), { timeout: 90_000 })
      .not.toBe(firstFrame);

    // Exactly one computer holds the machine. The keeper gave it up rather
    // than keeping a second copy running, and now follows the one it sent:
    // it becomes the viewer, and replication brings it a copy the other way.
    await expectReplica(keeper);
  } finally {
    await takerContext.close();
    await keeperContext.close();
  }
});

test("carries the machine's files to the computer that takes it", async ({
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

  const keeperContext = await browser.newContext();
  const takerContext = await browser.newContext();
  const keeper = await keeperContext.newPage();
  const taker = await takerContext.newPage();
  try {
    await keeper.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await taker.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expect(keeper.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    // The path matters more than the bytes. `/home/maker` is the shell's
    // working directory and a scratch mount of its own, not part of the `/`
    // image, so a move that carried only the root would restore every
    // process on top of an empty home and lose exactly the files a person
    // made.
    //
    // The taker's replica ran the same echo the keeper's machine ran, so
    // matching the written content on its screen would pass on a move that
    // carried no files at all. Erasing the keeper's screen and scrollback
    // before the take leaves nothing to match by accident: the content can
    // only reach the taker's screen by being read back off the machine.
    const written = `kandelo-carried-${Date.now().toString(36)}`;
    await closeDockPopovers([keeper]);
    await keeper.locator(".kshell-host").first().click();
    await keeper.keyboard.type(`echo ${written} > /home/maker/handover-probe`);
    await keeper.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(keeper, ".kshell-host"), { timeout: 60_000 })
      .toContain("handover-probe");
    await keeper.keyboard.type(String.raw`printf '\033[2J\033[3J\033[H'`);
    await keeper.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(keeper, ".kshell-host"), { timeout: 60_000 })
      .not.toContain(written);

    await connectPeers(keeper, taker, (reason) => test.skip(true, reason));
    await expectReplica(taker);

    await openNetworkPopover(taker);
    await takeOverButton(taker).click();

    // The taker holds the machine itself now.
    await expect(taker.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user", { timeout: 300_000 });
    await expect(taker.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    // The file the keeper made is on the machine that moved.
    await typeIntoTerminal(taker, ".kshell-host", "cat /home/maker/handover-probe");
    await expect
      .poll(() => terminalText(taker, ".kshell-host"), { timeout: 90_000 })
      .toContain(written);

    // A program the machine never ran comes with it too. Most of `/` is
    // deferred content: the file is there and its bytes are still a fetch
    // away, and which fetch that is lives in the image, not in the captured
    // filesystem bytes. A taker that attached to those bytes alone found
    // `/usr/bin/nano` present and empty, so every fork child that tried to
    // run it died on an unreadable program and `bash` printed nothing at all.
    await typeIntoTerminal(taker, ".kshell-host", "nano handover-probe");
    await expect
      .poll(() => terminalText(taker, ".kshell-host"), { timeout: 90_000 })
      .toContain("GNU nano");
  } finally {
    await takerContext.close();
    await keeperContext.close();
  }
});

/**
 * The keyboard moves with the machine, and it moves back.
 *
 * Exactly one of the two computers types at a time; the other runs a
 * read-only replica; and the one following can take the machine over, at
 * which point the two swap and can swap again. A take-over gated on which
 * computer sent the invite would pass the first half of this test and fail
 * the second, because that side is decided once and the machine keeps
 * moving.
 */
test("moves the keyboard with the machine, in both directions", async ({
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

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  try {
    await first.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await second.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expect(first.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    await connectPeers(first, second, (reason) => test.skip(true, reason));
    await expectReplica(second);

    // The computer with the machine cannot push it away, and the one
    // following is the one offered it.
    await openNetworkPopover(first);
    await openNetworkPopover(second);
    await expect(takeOverButton(first)).toHaveCount(0);
    await expect(takeOverButton(second)).toBeVisible({ timeout: 30_000 });

    // ── The machine moves to the second computer ────────────────────────────
    await takeOverButton(second).click();
    await closeDockPopovers([first, second]);
    await expect(second.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user", { timeout: 300_000 });
    await expect(second.locator(".kdock-status-text"))
      .toHaveAttribute("data-status", "running", { timeout: 300_000 });

    // So did the keyboard: the computer that took the machine types into it,
    // and the machine's decisions reach the computer that gave it up, which
    // is following its copy of it by now. Typing is also what lets that
    // replica arrive: a machine is read by freezing it, a process that makes
    // no syscall reaches no freeze hook, and this keystroke is what wakes
    // the shell for the next capture attempt.
    const typedBySecond = `kandelo-second-${Date.now().toString(36)}`;
    await typeIntoTerminal(second, ".kshell-host", `echo ${typedBySecond}`);
    await expect
      .poll(() => terminalText(second, ".kshell-host"), { timeout: 90_000 })
      .toContain(typedBySecond);
    await expectReplica(first);
    await expect
      .poll(() => terminalText(first, ".kshell-host"), { timeout: 180_000 })
      .toContain(typedBySecond);

    // The button changed sides with the machine. This is what a role fixed
    // at connection time could not do.
    await openNetworkPopover(first);
    await openNetworkPopover(second);
    await expect(takeOverButton(second)).toHaveCount(0);
    await expect(takeOverButton(first)).toBeVisible({ timeout: 30_000 });

    // ── And back to the first ───────────────────────────────────────────────
    await takeOverButton(first).click();
    await closeDockPopovers([first, second]);
    await expect(first.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user", { timeout: 300_000 });
    await expect(first.locator(".kdock-status-text"))
      .toHaveAttribute("data-status", "running", { timeout: 300_000 });

    const typedByFirst = `kandelo-first-${Date.now().toString(36)}`;
    await typeIntoTerminal(first, ".kshell-host", `echo ${typedByFirst}`);
    await expectReplica(second);
    await expect
      .poll(() => terminalText(second, ".kshell-host"), { timeout: 180_000 })
      .toContain(typedByFirst);

    await openNetworkPopover(first);
    await openNetworkPopover(second);
    await expect(takeOverButton(first)).toHaveCount(0);
    await expect(takeOverButton(second)).toBeVisible({ timeout: 30_000 });
  } finally {
    await secondContext.close();
    await firstContext.close();
  }
});

test("shows the viewer the page the user's machine is serving", async ({
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
    await sharer.goto(appUrl("/?demo=nginx"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

    // The machine serves its page to its own person first.
    await expect(sharer.frameLocator('iframe[title="nginx"]').locator("body"))
      .toContainText("Hello from nginx on WebAssembly!", { timeout: 300_000 });

    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));
    await expectReplica(viewer);

    // The viewer's page is served by the viewer's own machine: the sharer's
    // preview reloaded into the recording when it started, the replica
    // replayed those injections, and the viewer's preview followed the
    // sharer's to the page they produced. No pixel of it crossed the wire.
    await expect(viewer.frameLocator('iframe[title="nginx"]').locator("body"))
      .toContainText("Hello from nginx on WebAssembly!", { timeout: 180_000 });
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

test("a keeper that gave its machine away follows it rather than failing", async ({
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

  // A supervised profile, because this is about what init's exit means. Giving
  // a machine up destroys its kernel, and destroying it kills init — so the
  // keeper hears `dinit exited with code 137` moments after it said it holds
  // nothing. Read as a failure that is the status `error`, which takes neither
  // role: the keeper would stop asking to follow the machine it just sent, and
  // sit on a dead page reporting a machine that is running perfectly well on
  // the other computer. fbDOOM cannot show this — it boots its binary directly
  // and has no init to exit.
  const keeperContext = await browser.newContext();
  const takerContext = await browser.newContext();
  const keeper = await keeperContext.newPage();
  const taker = await takerContext.newPage();
  try {
    await keeper.goto(appUrl("/?demo=nginx"), { waitUntil: "domcontentloaded" });
    await taker.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expect(keeper.frameLocator('iframe[title="nginx"]').locator("body"))
      .toContainText("Hello from nginx on WebAssembly!", { timeout: 300_000 });

    await connectPeers(keeper, taker, (reason) => test.skip(true, reason));
    await expectReplica(taker);

    // Every status the keeper passes through, not just the one it settles on.
    // The keeper reaches `running` again either way once its own replica boots,
    // so polling the settled value proves nothing — the failure is a status it
    // passes through on the way there.
    await keeper.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __statuses: string[] }).__statuses = seen;
      const read = () => {
        const status = document.querySelector(".kdock-status-text")
          ?.getAttribute("data-status");
        if (status && seen[seen.length - 1] !== status) seen.push(status);
      };
      read();
      new MutationObserver(read).observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["data-status"],
      });
    });

    await openNetworkPopover(taker);
    await takeOverButton(taker).click();
    await closeDockPopovers([keeper, taker]);

    await expect(taker.locator(".kdock-status"))
      .toHaveAttribute("data-role", "user", { timeout: 300_000 });
    await expect(taker.frameLocator('iframe[title="nginx"]').locator("body"))
      .toContainText("Hello from nginx on WebAssembly!", { timeout: 300_000 });

    // The keeper follows the machine it gave away, and never called giving it
    // away a failure.
    await expectReplica(keeper);
    expect(
      await keeper.evaluate(
        () => (window as unknown as { __statuses: string[] }).__statuses,
      ),
    ).not.toContain("error");
  } finally {
    await takerContext.close();
    await keeperContext.close();
  }
});

/** A cheap frame fingerprint: enough to tell one frame from the next. */
function canvasSignature(canvas: Locator): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 997) sum = (sum + data[i]) | 0;
    return sum;
  });
}
