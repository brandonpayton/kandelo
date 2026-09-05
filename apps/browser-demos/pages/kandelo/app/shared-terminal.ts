// Terminal publishing — this machine's active terminal, offered to a peer.
//
// WHY: sharing must not depend on which pane is on screen. A publisher tied
// to the Shell pane would stop the moment the user looked at the demo
// surface, so this follows the host's terminal sessions instead.
//
// One terminal at a time. The viewer renders a single terminal, so a machine
// that published all of its sessions would leave the viewer resetting between
// screens it cannot show both of.
import * as React from "react";
import { LocalTerminalMirror } from "@host/migration/terminal-local";
import type { KernelHost } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PeerLink } from "../../../lib/peer-link";

/** True while this machine's active terminal is offered to the peer. */
export function useTerminalPublisher(
  host: KernelHost,
  link: PeerLink | null,
  path: string | undefined,
): boolean {
  const [sessions, setSessions] = React.useState<string[]>(() =>
    host.getTerminalSessions(),
  );

  React.useEffect(() => {
    setSessions(host.getTerminalSessions());
    return host.subscribeTerminalSessions(setSessions);
  }, [host]);

  // A pane can name a terminal before the host has attached it. Only a path
  // the host reports as a session is one there is anything to share.
  const sharedPath = path && sessions.includes(path) ? path : null;

  React.useEffect(() => {
    if (!link || !sharedPath) return;
    // The mirror wraps the link's channel; the link owns and closes it, so
    // stopping a publish here must not close the channel underneath it.
    const mirror = new LocalTerminalMirror(link.terminal);
    const shared = host.sharePty(sharedPath);
    if (!shared) return;
    const stop = mirror.publish(sharedPath, {
      onOutput: (listener) => shared.onData(listener),
      write: (bytes) => shared.write(bytes),
      size: () => shared.size(),
    });
    return () => {
      stop();
      shared.close();
    };
  }, [host, link, sharedPath]);

  return link !== null && sharedPath !== null;
}
