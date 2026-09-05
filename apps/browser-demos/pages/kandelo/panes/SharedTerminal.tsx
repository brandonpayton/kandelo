// Shared terminal pane — a terminal that belongs to the other computer.
//
// WHY: this browser holds no machine of its own. It renders text the peer's
// machine produced and sends back what the user types, so the page shows
// what it really is — a view of someone else's Kandelo — instead of
// presenting itself as a machine that is running here.
//
// What crosses the link is the terminal's bytes, not its pixels, so the text
// is rendered locally and stays sharp however far away the machine is. The
// geometry belongs to the publisher: this view adopts the cols and rows it
// is told and never fits its own container, because two emulators that both
// resize one PTY would fight over it.

import * as React from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { LocalTerminalMirror } from "@host/migration/terminal-local";
import type { PeerLink } from "../../../lib/peer-link";
import { readShellTheme } from "./Shell";

export const SharedTerminal: React.FC<{ link: PeerLink }> = ({ link }) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [live, setLive] = React.useState(false);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // React StrictMode mounts this effect twice; clear what xterm left.
    container.replaceChildren();
    const term = new Terminal({
      cursorBlink: true,
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

    const mirror = new LocalTerminalMirror(link.terminal);
    const encoder = new TextEncoder();
    let shownId: string | null = null;
    const stopWatch = mirror.watch({
      reset: (id, size, bytes) => {
        shownId = id;
        // A session reports its geometry only once an emulator has attached
        // to it; xterm rejects a zero, so keep what we have until it does.
        if (size.cols > 0 && size.rows > 0) term.resize(size.cols, size.rows);
        term.reset();
        term.write(bytes);
        setLive(true);
        term.focus();
      },
      output: (id, bytes) => {
        if (id !== shownId) return;
        term.write(bytes);
      },
    });
    const onInput = term.onData((data) => {
      if (!shownId) return;
      mirror.send(shownId, encoder.encode(data));
    });

    return () => {
      stopWatch();
      onInput.dispose();
      themeObserver.disconnect();
      term.dispose();
      setLive(false);
    };
  }, [link]);

  return (
    <div className="kshared-terminal">
      <div className="kshared-terminal-head">
        {live
          ? "Terminal on the other computer. What you type goes to its machine."
          : "Connected. Waiting for the other computer to share a terminal."}
      </div>
      <div className="kshell-host kshared-terminal-host" ref={containerRef} />
    </div>
  );
};
