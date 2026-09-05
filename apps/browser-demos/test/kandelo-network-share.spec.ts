import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Sharing a Kandelo machine with another computer, driven in one browser:
 * two isolated contexts share no BroadcastChannel, so everything that
 * crosses between them travels the manually signalled WebRTC link exactly
 * as it would between two real computers.
 *
 * The viewer holds no machine of its own. It renders the sharer's terminal
 * from the bytes that terminal produced, and the sharer's screen from the
 * pixels that machine wrote to /dev/fb0. Text crosses as text so it stays
 * sharp; a screen has no text to send, so its pixels cross instead.
 *
 * Watching carries no input authority over either surface. One computer holds
 * the machine and that computer keeps the keyboard: the shared screen sends
 * nothing back, and neither does the shared terminal, because two people
 * typing into one shell interleave their keystrokes inside a single line of
 * input and neither can tell which characters are theirs.
 *
 * Typing therefore moves the way the machine does, and moving a machine is
 * the handover's job. Two tests here are that handover: the viewer takes the
 * running fbDOOM over and the game carries on in the browser that took it,
 * and — because whoever holds the machine is whoever types — the keyboard
 * goes back the same way, as many times as the two people want.
 *
 * Chromium only, for the same reason as `migration-remote.spec.ts`: only
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

/** How many shell prompts a terminal is showing. */
async function prompts(page: Page, selector: string): Promise<number> {
  return (await terminalText(page, selector)).split("kandelo$").length - 1;
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
  // Everything the watching computer asks the network for, from before it
  // loads. Used below to show that it fetches the machine's image while it is
  // still only watching.
  const viewerRequests: string[] = [];
  viewer.on("request", (request) => viewerRequests.push(request.url()));
  try {
    await sharer.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });

    // The sharer needs a terminal open: a machine with no PTY session has
    // nothing to share, and the popup says so rather than pretending.
    await sharer.getByRole("button", { name: "Terminal", exact: true })
      .click({ timeout: 60_000 });
    await expect(sharer.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));

    // The popup exists to buy a connection, and there is one, so it is no
    // longer covering the machine it was opened to share.
    await expect(networkButton(sharer))
      .toHaveAttribute("aria-expanded", "false");
    await expect(networkButton(viewer))
      .toHaveAttribute("aria-expanded", "false");

    // The sharer reports what it is actually doing. One machine sends one
    // surface — the one its holder is looking at — so this is the terminal
    // and nothing else. A second sentence about the screen would describe a
    // surface the viewer is not being sent.
    await openNetworkPopover(sharer);
    await expect(sharer.locator(".knetwork-status"))
      .toContainText("Sharing this machine's terminal.", { timeout: 30_000 });
    await expect(sharer.locator(".knetwork-status"))
      .not.toContainText("this machine's screen");

    // The sharer is told which of the two computers types.
    await expect(sharer.locator(".knetwork-status"))
      .toContainText("You hold the machine, so you are the one that types");

    // The viewer shows the shared terminal. It carries no note while it
    // watches: a line over the screen covers what the person came to look at,
    // and the read-only explanation is moving to a dock badge instead.
    await expect(viewer.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 60_000 });
    await expect(viewer.locator(".kshared-terminal-note")).toHaveCount(0);
    await openNetworkPopover(viewer);
    await expect(viewer.locator(".knetwork-status"))
      .toContainText("The other computer holds the machine", {
        timeout: 30_000,
      });

    // With no screen published, the viewer shows no screen surface at all
    // rather than an empty canvas captioned as a machine.
    await expect(viewer.locator(".kshared-framebuffer")).toBeHidden();

    // Something is being shared, so the landing page and its waiting note are
    // gone. They come back only when the other computer shares nothing.
    await expect(viewer.locator(".kempty-peer-note")).toHaveCount(0);

    // The watching computer loads the machine's image before anyone asks it
    // to. Taking a machine is mostly not moving it: a viewer holds no image of
    // its own, so without this the whole load sits between the click and the
    // machine appearing, with the person who gave it away watching nothing.
    // A viewer that never takes has only fetched what it could have fetched
    // anyway, so this costs a download and promises nothing.
    // Matched on the image bytes, not on any URL with "vfs" in it: the dev
    // server also serves a module graph full of them, and a page that has
    // merely loaded requests several. `.vfs.zst` without Vite's `?import`
    // suffix is the image itself, and a computer holding no machine has no
    // other reason to ask for one.
    await expect
      .poll(
        () =>
          viewerRequests.filter(
            (url) => url.includes(".vfs.zst") && !url.includes("?import"),
          ).length,
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

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

    // A late watcher is seeded with a full replay, and the publisher sends
    // another for every hello and every drain. xterm clears at once but parses
    // a write later, so a viewer that discarded the screen outside the byte
    // stream would clear an already empty buffer once per replay and then
    // render all of them: one prompt per replay instead of the one screen the
    // sharer is showing.
    await expect
      .poll(() => prompts(viewer, ".kshared-terminal"), { timeout: 60_000 })
      .toBe(await prompts(sharer, ".kshell-host"));

    await closeDockPopovers([sharer, viewer]);

    // Text the sharer's machine printed reaches the viewer.
    const fromSharer = `kandelo-share-${Date.now().toString(36)}`;
    await sharer.locator(".kshell-host").first().click();
    await sharer.keyboard.type(`echo ${fromSharer}`);
    await sharer.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(viewer, ".kshared-terminal"), { timeout: 90_000 })
      .toContain(fromSharer);

    // Nothing the viewer types reaches the sharer's shell. Two people typing
    // into one shell interleave their keystrokes inside a single line of
    // input, so the computer holding the machine keeps the keyboard and this
    // one only watches.
    const fromViewer = `kandelo-typed-${Date.now().toString(36)}`;
    await viewer.locator(".kshared-terminal-host").click();
    await viewer.keyboard.type(`echo ${fromViewer}`);
    await viewer.keyboard.press("Enter");

    // Proved against a round trip that does arrive, rather than against a
    // fixed wait: the sharer types after the viewer did, and the far slower
    // path — sharer's shell, over the link, onto the viewer's screen —
    // completes. Anything the viewer sent would have been on the sharer's
    // shell long before that.
    const afterwards = `kandelo-after-${Date.now().toString(36)}`;
    await sharer.locator(".kshell-host").first().click();
    await sharer.keyboard.type(`echo ${afterwards}`);
    await sharer.keyboard.press("Enter");
    await expect
      .poll(() => terminalText(viewer, ".kshared-terminal"), { timeout: 90_000 })
      .toContain(afterwards);

    expect(await terminalText(sharer, ".kshell-host")).not.toContain(fromViewer);

    // Nor did the keystrokes land anywhere else and come back: the viewer's
    // own screen is the sharer's screen, and it never showed them either.
    expect(await terminalText(viewer, ".kshared-terminal"))
      .not.toContain(fromViewer);
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

/**
 * A connected computer that is being shown nothing is still the landing page.
 *
 * The link's state belongs on the page the user is looking at, said once. A
 * surface that has nothing to draw contributes no caption of its own, so the
 * note lives with the Kandelo mark and leaves as soon as a surface arrives.
 */
test("says it is waiting only until the other computer shares something", async ({
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
    // A machine with no surface open. The shell demo attaches a terminal as it
    // boots, so it can never be seen waiting; the nginx demo boots a service
    // and opens nothing, which is the state this test is about.
    await sharer.goto(appUrl("/?demo=nginx"), { waitUntil: "domcontentloaded" });
    await viewer.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await connectPeers(sharer, viewer, (reason) => test.skip(true, reason));

    await expect(viewer.locator(".kempty-peer-note"))
      .toContainText("Waiting for the other computer to share a screen", {
        timeout: 30_000,
      });
    await expect(viewer.locator(".kshared-terminal")).toBeHidden();
    await expect(viewer.locator(".kshared-framebuffer")).toBeHidden();

    // Choosing what to run is what ends the wait. The note goes, and what the
    // other computer opened is what this one sees.
    await sharer.getByRole("button", { name: "Terminal", exact: true })
      .click({ timeout: 60_000 });
    await expect(sharer.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    await expect(viewer.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 90_000 });
    await expect(viewer.locator(".kempty-peer-note")).toHaveCount(0);
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

test("shares a running fbDOOM screen with a computer that has none", async ({
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

    // fbDOOM writes to /dev/fb0 rather than mapping it, so the mirror has a
    // stream to forward and the sharer says it is forwarding it.
    await openNetworkPopover(sharer);
    await expect(sharer.locator(".knetwork-status"))
      .toContainText("Sharing this machine's screen.", { timeout: 30_000 });

    // The viewer paints the sharer's frames, not a placeholder.
    await expect(viewer.locator(".kshared-framebuffer"))
      .toBeVisible({ timeout: 90_000 });
    const viewerCanvas = viewer.locator("canvas.kframebuffer-canvas").first();
    await expect(viewerCanvas).toBeVisible();
    await expect.poll(() => distinctColors(viewerCanvas), {
      timeout: 120_000,
      intervals: [1_000, 2_000, 3_000],
    }).toBeGreaterThan(4);

    // The screen is live, not one seeded frame: DOOM's demo loop keeps
    // playing, so the viewer's pixels keep changing.
    const firstFrame = await canvasSignature(viewerCanvas);
    await expect
      .poll(() => canvasSignature(viewerCanvas), { timeout: 60_000 })
      .not.toBe(firstFrame);

    await closeDockPopovers([sharer, viewer]);

    // Watching carries no input authority. The viewer's canvas is not
    // focusable and forwards nothing, so the sharer keeps the only keyboard.
    await expect(viewerCanvas).not.toHaveAttribute("tabindex", "0");
  } finally {
    await viewerContext.close();
    await sharerContext.close();
  }
});

/**
 * The whole handover, over a real peer connection, on a machine nobody has
 * reshaped for the test: a login shell in `wait4` and fbDOOM painting.
 *
 * This is the case the freeze could not do before ABI 45. The host publishes a
 * process's unwind request on a syscall *completion*
 * (`CentralizedKernelWorker.#publishCheckpointUnwindRequest`), and a process
 * parked in a blocking syscall the kernel has not completed never reaches one,
 * so the freeze timed out with `pid N (bash) is armed`. Arming the freeze now
 * interrupts the outstanding wait with EINTR and asks the glue to resubmit it
 * after the restore, which is what lets a whole machine move.
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
  test.setTimeout(300_000);
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
    await expect(taker.locator(".kshared-framebuffer"))
      .toBeVisible({ timeout: 90_000 });

    // The take sits with the link's other controls, in the network popup the
    // connection was made in, and only the computer holding no machine of its
    // own is offered it: a keeper cannot push its machine away. Both popups
    // are opened for this, because the connection closed them behind itself.
    await openNetworkPopover(keeper);
    await openNetworkPopover(taker);
    await expect(keeper.getByRole("button", { name: "Take over this machine" }))
      .toHaveCount(0);
    await taker.getByRole("button", { name: "Take over this machine" }).click();
    await closeDockPopovers([keeper, taker]);

    // The computer taking the machine is not sent back to the landing page
    // while it boots. It keeps the last frame it was watching, dimmed, because
    // a machine has to boot its image here before the checkpoint can restore
    // into it and the boot is far longer than these five seconds.
    await expect(taker.locator(".kshared-framebuffer.is-held"))
      .toBeVisible({ timeout: 5_000 });
    await expect(taker.locator(".kempty-peer-note")).toHaveCount(0);

    // The taker stops being a viewer because it now holds the machine
    // itself: no shared surface remains to watch.
    await expect(taker.locator(".kshared-machine"))
      .toHaveCount(0, { timeout: 180_000 });

    // The game carries on from the frame it was frozen on, in the browser
    // that took it. A machine that arrived dead would paint one still frame.
    const takerCanvas = taker.locator("canvas.kframebuffer-canvas").first();
    await expect(takerCanvas).toBeVisible({ timeout: 60_000 });
    const firstFrame = await canvasSignature(takerCanvas);
    await expect
      .poll(() => canvasSignature(takerCanvas), { timeout: 90_000 })
      .not.toBe(firstFrame);

    // Exactly one computer holds the machine. The keeper gave it up rather
    // than keeping a second copy running, and now watches the one it sent.
    await expect(keeper.locator(".kshared-machine"))
      .toBeVisible({ timeout: 60_000 });
    await expect(keeper.locator(".kshared-framebuffer"))
      .toBeVisible({ timeout: 90_000 });

    // One machine sends one surface, so the computer watching it shows one.
    // The screen this computer kept while the machine moved is a stand-in for
    // a surface that is not live yet; a machine that comes back drawing pixels
    // leaves nothing to stand in for. Holding both split the pane in half and
    // put a dead boot log under a running game.
    await expect(keeper.locator(".kshared-terminal")).toBeHidden();

    // And it stays one surface as the person holding the machine turns from
    // one to the other. A watcher told only "here are pixels" and "here is
    // text", never "that one has stopped", ends up showing both at half
    // height: the game it is watching above the terminal it was watching
    // before, with nothing saying which one is being used.
    await taker.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(keeper.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 60_000 });
    await expect(keeper.locator(".kshared-framebuffer")).toBeHidden();

    await taker.getByRole("button", { name: "Demo", exact: true }).click();
    await expect(keeper.locator(".kshared-framebuffer"))
      .toBeVisible({ timeout: 60_000 });
    await expect(keeper.locator(".kshared-terminal")).toBeHidden();
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
  test.setTimeout(300_000);
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

    // A machine that booted a demo opens that demo's guide, with no link and
    // no take-over involved, so the dismiss layer is over this terminal from
    // the first frame. Clear the popovers before the click, exactly as the
    // sharing test above does.
    //
    // The path matters more than the bytes. `/home/maker` is the shell's
    // working directory and a scratch mount of its own, not part of the `/`
    // image, so a handover that moved only the root would restore every
    // process on top of an empty home and lose exactly the files a person
    // made.
    //
    // The taker seeds its terminal from what moved with the machine, so the
    // keeper's own typing arrives on the taker's screen before the taker has
    // typed anything. Matching the written content there would pass on a
    // handover that carried no files at all. Erasing the keeper's screen and
    // its scrollback before the handover leaves nothing to match by accident,
    // so the content can only reach the taker's screen by being read back off
    // the machine that moved.
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
    await expect(taker.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 90_000 });

    await openNetworkPopover(taker);
    await taker.getByRole("button", { name: "Take over this machine" }).click();

    // The taker holds the machine now, so it renders one rather than watching.
    await expect(taker.locator(".kshared-machine"))
      .toHaveCount(0, { timeout: 180_000 });
    await expect(taker.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    // After the machine has arrived and its guide has opened, not before: a
    // taker cleared of popovers any earlier is covered again by the time it is
    // typed into.
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
 * This is the whole user-and-viewer arrangement in one run. Exactly one of the
 * two computers types at a time; the other watches a read-only terminal; and
 * the one watching can take the machine over, at which point the two swap and
 * can swap again. A take-over gated on which computer sent the invite would
 * pass the first half of this test and fail the second, because that side is
 * decided once and the machine keeps moving.
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
  test.setTimeout(300_000);
  expect(baseURL).toBeTruthy();

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const takeOver = (page: Page) =>
    page.getByRole("button", { name: "Take over this machine" });
  try {
    await first.goto(appUrl("/?demo=shell"), { waitUntil: "domcontentloaded" });
    await second.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
    await expect(first.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    // Put something identifiable on the first computer's screen, so that what
    // it keeps showing after the machine leaves can be recognised as the
    // screen it had rather than as anything the peer sent.
    const kept = `kandelo-kept-${Date.now().toString(36)}`;
    await typeIntoTerminal(first, ".kshell-host", `echo ${kept}`);
    await expect
      .poll(() => terminalText(first, ".kshell-host"), { timeout: 60_000 })
      .toContain(kept);

    await connectPeers(first, second, (reason) => test.skip(true, reason));
    await expect(second.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 90_000 });

    // The computer with the machine cannot push it away, and the one watching
    // is the one offered it. The popups are opened for this: connecting closed
    // them, and the take lives inside them.
    await openNetworkPopover(first);
    await openNetworkPopover(second);
    await expect(takeOver(first)).toHaveCount(0);
    await expect(takeOver(second)).toBeVisible({ timeout: 30_000 });

    // ── The machine moves to the second computer ────────────────────────────
    await takeOver(second).click();

    // The computer that gave the machine away is not sent back to the landing
    // page while the machine starts elsewhere. It keeps the screen it had, and
    // says so. The five seconds are the point of the assertion: booting the
    // image on the other computer takes far longer than that, and a pane that
    // waited for the peer's first frame would still be hidden here.
    await expect(first.locator(".kshared-terminal.is-held"))
      .toBeVisible({ timeout: 5_000 });
    await expect(first.locator(".kempty-peer-note")).toHaveCount(0);
    // A machine that never sent a screen leaves no screen to keep. The pane
    // that would keep one stays away rather than holding up a black canvas
    // beside the terminal that is the thing this person was actually looking
    // at.
    await expect(first.locator(".kshared-framebuffer")).toBeHidden();
    // The same five seconds, and for the same reason: the pane becomes visible
    // one frame before the emulator has painted its rows into it, so reading
    // the text once catches an empty screen that fills immediately afterwards.
    await expect
      .poll(() => terminalText(first, ".kshared-terminal"), { timeout: 5_000 })
      .toContain(kept);

    await expect(second.locator(".kshared-machine"))
      .toHaveCount(0, { timeout: 180_000 });
    await expect(second.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });

    // The screen moved with the machine. A terminal is machine state, so the
    // computer that took it continues the session it was watching instead of
    // opening an empty one — and, because it adopts the restored process
    // rather than starting a second on the same PTY, it does not paint a fresh
    // login's banner over what was already there.
    // Containing it is also what proves the restored process was adopted: a
    // second login started on the same PTY gets a session of its own with an
    // empty screen, so this text would be nowhere on it.
    await expect
      .poll(() => terminalText(second, ".kshell-host"), { timeout: 120_000 })
      .toContain(kept);

    // Replaced by the peer's live screen once there is one, so the dimmed
    // farewell is a gap-filler and not a second thing to read.
    await expect(first.locator(".kshared-terminal.is-held"))
      .toHaveCount(0, { timeout: 90_000 });
    await expect(first.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 90_000 });

    // The button changed sides with the machine. This is what a role fixed at
    // connection time could not do.
    await openNetworkPopover(first);
    await openNetworkPopover(second);
    await expect(takeOver(second)).toHaveCount(0);
    await expect(takeOver(first)).toBeVisible({ timeout: 30_000 });

    // So did the keyboard: the computer that took the machine types into it,
    // and the computer that gave it up sees what was typed.
    const typedBySecond = `kandelo-second-${Date.now().toString(36)}`;
    await typeIntoTerminal(second, ".kshell-host", `echo ${typedBySecond}`);
    await expect
      .poll(() => terminalText(first, ".kshared-terminal"), { timeout: 90_000 })
      .toContain(typedBySecond);

    // ── And back to the first ───────────────────────────────────────────────
    await openNetworkPopover(first);
    await takeOver(first).click();
    await expect(first.locator(".kshared-machine"))
      .toHaveCount(0, { timeout: 180_000 });
    await expect(first.locator(".kshell-host .xterm-rows").first())
      .toBeVisible({ timeout: 120_000 });
    await expect(second.locator(".kshared-terminal"))
      .toBeVisible({ timeout: 90_000 });

    await openNetworkPopover(first);
    await openNetworkPopover(second);
    await expect(takeOver(first)).toHaveCount(0);
    await expect(takeOver(second)).toBeVisible({ timeout: 30_000 });

    // The first computer holds the keyboard again, and the second is watching
    // again.
    const typedByFirst = `kandelo-first-${Date.now().toString(36)}`;
    await typeIntoTerminal(first, ".kshell-host", `echo ${typedByFirst}`);
    await expect
      .poll(() => terminalText(second, ".kshared-terminal"), { timeout: 90_000 })
      .toContain(typedByFirst);
  } finally {
    await secondContext.close();
    await firstContext.close();
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
