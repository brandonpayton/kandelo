// Shared machine pane — the other computer's machine, watched from here.
//
// WHY: this browser holds no machine of its own, and the screen and the
// terminal it can see are two surfaces of one machine somewhere else. A
// viewer should see what that computer sees, so a surface it is not using
// contributes nothing: an idle machine shows neither an empty canvas nor a
// caption explaining the emptiness, and the pane falls back to whatever the
// page would show with no peer at all.
//
// Both panes stay mounted and at most one of them is live, because the machine
// sends only the surface its holder is presenting. Which one that is changes
// when the other person switches view, and a mirror learns its surface has
// started only by already watching for it — and learns that it has stopped
// only by being told, because a surface nobody is using goes quiet exactly the
// way a live one does between frames.
//
// Taking the machine over is not on this pane. It is the one control that
// moves a machine rather than showing one, and it lives beside Disconnect in
// the network popup, where the rest of the link's controls are.

import * as React from "react";
import { SharedFramebuffer } from "./SharedFramebuffer";
import { SharedTerminal } from "./SharedTerminal";
import type { TerminalScreen } from "../app/shared-terminal";
import type { PeerLink } from "../../../lib/peer-link";

export const SharedMachine: React.FC<{
  link: PeerLink;
  /**
   * True while a machine is on its way between the two computers.
   *
   * Each pane keeps the surface it was showing for as long as this lasts. The
   * screen pane keeps the last frame it painted; the terminal pane keeps
   * `held`, because a terminal's text has to be carried across the move rather
   * than left on a canvas.
   */
  moving: boolean;
  /**
   * The screen kept from a machine that is moving between the two computers,
   * or null.
   *
   * A pane holding one counts as showing something, so `idle` stays away:
   * neither the person who just gave their machine away nor the person whose
   * machine is still booting is a person waiting for someone to share one.
   */
  held: TerminalScreen | null;
  /** Shown while the other computer is sharing no surface at all. */
  idle: React.ReactNode;
}> = ({ link, moving, held, idle }) => {
  const [screenLive, setScreenLive] = React.useState(false);
  const [terminalLive, setTerminalLive] = React.useState(false);

  return (
    <div className="kshared-machine">
      {!screenLive && !terminalLive && idle}
      {/* A kept surface stands in for a surface that is not live yet, and one
          machine sends one surface. Each pane therefore drops what it is
          keeping the moment the other one is live: a machine that comes back
          printing text leaves no frame worth holding, and one that comes back
          drawing pixels leaves no screen worth holding. Keeping both splits
          the pane in half and puts a dead surface beside a running one. */}
      <SharedFramebuffer
        link={link}
        holding={moving && !terminalLive}
        onLive={setScreenLive}
      />
      <SharedTerminal
        link={link}
        held={screenLive ? null : held}
        onLive={setTerminalLive}
      />
    </div>
  );
};
