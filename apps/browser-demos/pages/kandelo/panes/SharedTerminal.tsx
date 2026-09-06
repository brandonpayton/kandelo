// Shared terminal pane — a terminal that belongs to the other computer.
//
// WHY: this browser holds no machine of its own. It renders text the peer's
// machine produced, so the page shows what it really is — a view of someone
// else's Kandelo — instead of presenting itself as a machine that is running
// here.
//
// Read-only. One computer holds the machine and that computer keeps the
// keyboard, because two people typing into one shell interleave their
// keystrokes inside a single line of input. The way to type is to take the
// machine over, in the Network popup.
//
// A terminal is the surface a person most expects to be able to type into, so
// a silent read-only one still owes the person that explanation. It is not
// given here: a line over the screen covers the thing the person came to look
// at. The dock carries it instead, as a Viewer badge beside the machine name
// (`Dock.tsx`, `kdock-role`) — always visible, never over the machine.
//
// What crosses the link is the terminal's bytes, not its pixels, so the text
// is rendered locally and stays sharp however far away the machine is. The
// geometry belongs to the publisher: this view adopts the cols and rows it
// is told and never fits its own container, because two emulators that both
// resize one PTY would fight over it.
//
// A pane with no session stays hidden and reports that through `onLive` — the
// machine pane says once, in one place, that nothing is being shared yet.
//
// Except while a machine is moving between the two computers. Both sides have
// a screen from a moment ago and neither has a live one yet: the giver has the
// screen it was showing, the taker has the screen it was watching, and a
// machine takes a whole boot to start on its new computer because the image
// has to come up before the checkpoint can restore into it. Dropping to the
// landing page for that boot tells the person they have nothing, so the pane
// keeps the screen up, dimmed, and swaps it for the live one when it arrives.
// Dimmed because it is exactly that: a screen from a machine that is not
// running here yet, or not any more.

import * as React from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { LocalTerminalMirror } from "@host/migration/terminal-local";
import type { TerminalScreen } from "../app/shared-terminal";
import type { PeerLink } from "../../../lib/peer-link";
import { readShellTheme } from "./Shell";

/** RIS — reset to initial state: screen, scrollback and modes. */
const RESET_TO_INITIAL_STATE = "\u001bc";

export const SharedTerminal: React.FC<{
  link: PeerLink;
  /**
   * The screen kept from a machine that is moving, or null.
   *
   * Shown until a live screen replaces it. Read when the pane opens: the
   * machine that drew it is not drawing here, so it cannot change afterwards.
   */
  held: TerminalScreen | null;
  /** Told whether the pane shows anything, so the machine pane can lay itself out. */
  onLive: (live: boolean) => void;
}> = ({ link, held, onLive }) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [live, setLive] = React.useState(false);
  const showing = live || held !== null;
  // Read inside the effect without being a dependency of it. A new object with
  // the same bytes must not tear down the emulator and rebuild it, and the
  // machine that drew this screen is not drawing here, so there is no later
  // value to pick up either.
  const heldRef = React.useRef(held);
  heldRef.current = held;

  React.useEffect(() => onLive(showing), [showing, onLive]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // React StrictMode mounts this effect twice; clear what xterm left.
    container.replaceChildren();
    const term = new Terminal({
      // The cursor belongs to the machine's shell, so it is drawn where that
      // shell put it and it does not blink here: a blinking cursor invites the
      // typing this terminal cannot accept.
      cursorBlink: false,
      // Refuses the keyboard at the emulator rather than dropping keystrokes
      // further down. xterm then takes no focus, so a click lands on the page
      // instead of on a terminal that would swallow it.
      disableStdin: true,
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
      theme: readShellTheme(container),
      allowProposedApi: true,
    });
    term.open(container);
    const applyTheme = () => {
      term.options.theme = readShellTheme(container);
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-k-theme", "data-k-mode", "style"],
    });

    // The screen kept from the machine that is moving, put up before there is
    // a live one to show. The live reset that eventually arrives carries RIS,
    // so it clears this on its way in.
    const kept = heldRef.current;
    if (kept) {
      term.resize(kept.size.cols, kept.size.rows);
      term.write(kept.bytes);
    }

    const mirror = new LocalTerminalMirror(link.terminal);
    let shownId: string | null = null;
    const stopWatch = mirror.watch({
      reset: (id, size, bytes) => {
        shownId = id;
        // A session reports its geometry only once an emulator has attached
        // to it; xterm rejects a zero, so keep what we have until it does.
        if (size.cols > 0 && size.rows > 0) term.resize(size.cols, size.rows);
        // Discarding the screen has to travel inside the byte stream. xterm
        // parses writes asynchronously while reset() clears at once, so two
        // replays that arrive together would each clear a screen still empty
        // and then render one after the other. RIS is parsed in its own
        // replay's turn, and the bytes behind it re-establish the modes it
        // drops.
        term.write(RESET_TO_INITIAL_STATE);
        term.write(bytes);
        setLive(true);
      },
      output: (id, bytes) => {
        if (id !== shownId) return;
        term.write(bytes);
      },
      // The machine turned to its other surface, or left. Either way this pane
      // is showing a screen nothing is driving any more, and the pane it
      // shares its column with is about to show the surface that replaced it.
      ended: (id) => {
        if (id !== shownId) return;
        shownId = null;
        setLive(false);
      },
    });
    return () => {
      stopWatch();
      themeObserver.disconnect();
      term.dispose();
      setLive(false);
    };
  }, [link]);

  const holding = !live && held !== null;

  return (
    <div
      className={`kshared-terminal${holding ? " is-held" : ""}`}
      hidden={!showing}
    >
      <div className="kshell-host kshared-terminal-host" ref={containerRef} />
    </div>
  );
};
