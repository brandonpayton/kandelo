// Framebuffer publishing — this machine's screen, offered to a peer.
//
// WHY: the publisher follows the machine's /dev/fb0 binding rather than the
// Framebuffer pane, so it does not depend on a pane being mounted. It does
// depend on the surface the person holding the machine is presenting: a
// viewer is watching one machine, and a machine drawing a screen while a
// shell runs underneath it would send both, leaving the viewer with two
// surfaces stacked in one column and no way to tell which one is being used.
// One machine, one surface — the one its holder is looking at.
//
// Publishing carries no input authority in either direction. The mirror
// forwards pixels one way; the keyboard and the mouse stay with the pane
// that attached the canvas, so a viewer sees the screen move and cannot
// move it. Moving the machine itself is the handover's job, not the
// mirror's.
import * as React from "react";
import { LocalFramebufferMirror } from "@host/migration/mirror-local";
import { useStatus } from "../kernel-host/react";
import type {
  KernelHost,
  SharedFramebufferHandle,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PeerLink } from "../../../lib/peer-link";

export interface FramebufferSharing {
  /** True while this machine's screen is offered to the peer. */
  readonly sharing: boolean;
  /** Why the screen cannot be mirrored, or null when nothing refuses it. */
  readonly refusal: string | null;
}

const NOT_SHARING: FramebufferSharing = { sharing: false, refusal: null };

export function useFramebufferPublisher(
  host: KernelHost,
  link: PeerLink | null,
  /** Whether the person holding this machine is presenting its /dev/fb0 screen. */
  presenting: boolean,
): FramebufferSharing {
  const status = useStatus();
  const [shared, setShared] = React.useState<SharedFramebufferHandle | null>(null);
  const [boundPid, setBoundPid] = React.useState<number | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);

  // The registry exists only once a kernel is attached, so re-acquire the
  // handle whenever the machine reaches 'running' again.
  React.useEffect(() => {
    if (status !== "running") return;
    const handle = host.shareFramebuffer();
    if (!handle) return;
    setShared(handle);
    setBoundPid(handle.getBoundPid());
    const offBound = handle.onBoundPidChange(setBoundPid);
    return () => {
      offBound();
      handle.close();
      setShared(null);
      setBoundPid(null);
    };
  }, [host, status]);

  React.useEffect(() => {
    if (!link || !shared || boundPid === null || !presenting) return;
    // An mmap-based binding keeps its pixels in the process's own memory and
    // produces no write stream, so there is nothing for the mirror to
    // forward. Say so rather than publish a first frame that would never
    // update and read to a viewer as a frozen machine.
    if (!shared.registry.get(boundPid)?.hostBuffer) {
      setRefusal(
        `pid ${boundPid} maps /dev/fb0 into its own memory, so its screen `
        + `produces no write stream to mirror`,
      );
      return;
    }
    setRefusal(null);
    // The mirror wraps the link's channel; the link owns and closes it, so
    // stopping a publish here must not close the channel underneath it.
    const mirror = new LocalFramebufferMirror(link.mirror);
    return mirror.publish(shared.registry, boundPid);
  }, [boundPid, link, presenting, shared]);

  if (!link || boundPid === null || !presenting) return NOT_SHARING;
  return { sharing: refusal === null, refusal };
}
