// Terminal publishing — this machine's active terminal, offered to a peer.
//
// WHY: the publisher follows the host's terminal sessions rather than the
// Shell pane, so it does not depend on a pane being mounted. It does depend on
// the surface the person holding the machine is presenting: a viewer watching
// a machine that sent its screen and its shell at once would see two surfaces
// stacked in one column, with nothing saying which of them is being used. One
// machine, one surface — the one its holder is looking at.
//
// One terminal at a time. The viewer renders a single terminal, so a machine
// that published all of its sessions would leave the viewer resetting between
// screens it cannot show both of.
//
// It also keeps the screen the terminal is showing. Handing the machine over
// destroys this computer's kernel, which unmounts the Shell pane and with it
// the emulator holding the text; without a copy taken beforehand there is
// nothing left to show, and the person who chose to hand the machine over
// would watch the landing page until the machine started somewhere else. The
// bytes are the ones the session is already producing, so the copy costs a
// reference.
//
// The copy is kept whether or not the terminal is the surface being published.
// It answers what this computer had on screen when it gave the machine away,
// and that question does not stop being asked because the person was looking
// at the machine's screen a moment before they handed it over.
import * as React from "react";
import {
  LocalTerminalMirror,
  ReplayTail,
  type TerminalSize,
} from "@host/migration/terminal-local";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PeerLink } from "../../../lib/peer-link";

/** A terminal screen, kept so it can outlive the machine that drew it. */
export interface TerminalScreen {
  readonly bytes: Uint8Array;
  readonly size: TerminalSize;
}

export interface TerminalSharing {
  /** True while this machine's active terminal is offered to the peer. */
  readonly sharing: boolean;
  /** The last screen published from here, or null if none ever was. */
  lastScreen(): TerminalScreen | null;
}

export function useTerminalPublisher(
  host: KernelHost,
  link: PeerLink | null,
  path: string | undefined,
  /** Whether the person holding this machine is presenting its terminal. */
  presenting: boolean,
): TerminalSharing {
  const [sessions, setSessions] = React.useState<string[]>(() =>
    host.getTerminalSessions(),
  );
  // Refs, not state: these are read once, at the moment the machine leaves,
  // and a render for every chunk a busy terminal prints would cost more than
  // the one thing they buy. The tail is joined on that read rather than on
  // every append, so a machine printing a build log pays a reference per
  // chunk instead of copying its whole scrollback each time.
  const tailRef = React.useRef<ReplayTail | null>(null);
  const sizeRef = React.useRef<TerminalSize | null>(null);

  React.useEffect(() => {
    setSessions(host.getTerminalSessions());
    return host.subscribeTerminalSessions(setSessions);
  }, [host]);

  // A pane can name a terminal before the host has attached it. Only a path
  // the host reports as a session is one there is anything to share.
  const sharedPath = path && sessions.includes(path) ? path : null;

  // Keeping the screen and publishing it are two jobs with two lifetimes, so
  // they are two subscriptions. The keeper's own copy has to survive the
  // person switching to the machine's screen and back; a publish must stop the
  // moment they do. `sharePty` hands out an independent reader each time it is
  // called, so each job holds its own.
  React.useEffect(() => {
    // Only with a peer: the screen is kept to be shown after this machine is
    // handed to one, and a computer with nobody to hand it to is paying to
    // keep a second copy of text it already has on screen.
    if (!link || !sharedPath) return;
    const shared = host.sharePty(sharedPath);
    if (!shared) return;
    const tail = new ReplayTail();
    tailRef.current = tail;
    const stop = shared.onData((bytes) => {
      tail.append(bytes.slice());
      // Read here rather than at the snapshot: by then the machine is gone and
      // the session the size would come from has been invalidated.
      sizeRef.current = shared.size();
    });
    return () => {
      stop();
      shared.close();
    };
  }, [host, link, sharedPath]);

  React.useEffect(() => {
    if (!link || !sharedPath || !presenting) return;
    // The mirror wraps the link's channel; the link owns and closes it, so
    // stopping a publish here must not close the channel underneath it.
    const mirror = new LocalTerminalMirror(link.terminal);
    const shared = host.sharePty(sharedPath);
    if (!shared) return;
    // A new reader is replayed the session's history, so a publish that starts
    // when the person turns back to the terminal seeds the peer with the whole
    // screen rather than with whatever is printed next.
    const stop = mirror.publish(sharedPath, {
      onOutput: (listener) => shared.onData(listener),
      size: () => shared.size(),
    });
    return () => {
      stop();
      shared.close();
    };
  }, [host, link, presenting, sharedPath]);

  const lastScreen = React.useCallback((): TerminalScreen | null => {
    const tail = tailRef.current;
    const size = sizeRef.current;
    // A session reports its geometry only once an emulator has attached, and
    // an emulator rejects a zero. Without both there is no screen to redraw.
    if (!tail || !size || size.cols <= 0 || size.rows <= 0) return null;
    const bytes = tail.snapshot();
    return bytes.byteLength > 0 ? { bytes, size } : null;
  }, []);

  return {
    sharing: link !== null && sharedPath !== null && presenting,
    lastScreen,
  };
}
