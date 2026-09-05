// Shared framebuffer pane — a screen that belongs to the other computer.
//
// WHY: this browser holds no machine of its own. It paints the pixels the
// peer's machine wrote to /dev/fb0, so the page shows what it really is — a
// view of someone else's Kandelo — instead of presenting itself as a machine
// that is running here.
//
// What crosses the link is the pixel stream, not the machine. This view
// sends nothing back: input authority stays with the computer that owns the
// process, and "take over" is what moves it. A viewer that could type into a
// screen it does not own would be two machines diverging from one state.
//
// The pane carries no caption. A viewer should see what the other computer
// sees, so a surface that is drawing shows only its pixels, and a surface
// that is dark stays hidden and reports that through `onLive` — the machine
// pane says once, in one place, that nothing is being shared yet.
//
// Except while a machine is moving between the two computers, which is what
// `holding` names. Neither side has a live screen then: the giver has just
// given its machine away, and the taker has a whole boot to sit through
// before the checkpoint can restore into it. Dropping to the landing page for
// that boot tells the person they have nothing, so the pane keeps the last
// frame it painted, dimmed, and swaps it for the live one when it arrives.
// Dimmed because it is exactly that: a screen from a machine that is not
// running here yet, or not any more.

import * as React from "react";
import { FramebufferRegistry, attachCanvas } from "@host/framebuffer";
import { LocalFramebufferMirror } from "@host/migration/mirror-local";
import type { PeerLink } from "../../../lib/peer-link";
import { useFittedCanvasStyle } from "./canvasFit";

/** fbDOOM's 640×400 screen, used until the peer announces its geometry. */
const FALLBACK_ASPECT = 16 / 10;

export const SharedFramebuffer: React.FC<{
  link: PeerLink;
  /** True while a machine is on its way between the two computers. */
  holding: boolean;
  /** Told whether the pane shows anything, so the machine pane can lay itself out. */
  onLive: (live: boolean) => void;
}> = ({ link, holding, onLive }) => {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [live, setLive] = React.useState(false);
  // A machine that never sent a screen leaves nothing to keep. Without this a
  // terminal machine on its way over would hold up an empty black canvas.
  const [painted, setPainted] = React.useState(false);
  const keeping = !live && holding && painted;
  const showing = live || keeping;

  React.useEffect(() => onLive(showing), [showing, onLive]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const registry = new FramebufferRegistry();
    let detach: (() => void) | null = null;
    const offChange = registry.onChange((pid, event) => {
      if (event !== "bind") {
        // The machine turned to its other surface, or left, or the process
        // gave /dev/fb0 up. Stopping the renderer leaves the last frame on the
        // canvas: whether that frame is still worth showing is `holding`'s
        // answer, not this one's.
        detach?.();
        detach = null;
        setLive(false);
        return;
      }
      detach?.();
      // A mirrored binding is host-buffer backed by construction: the
      // publisher forwards a write stream, and this browser holds no process
      // whose memory a renderer could read instead.
      detach = attachCanvas(canvas, registry, pid, {
        getProcessMemory: () => undefined,
      });
      setLive(true);
      setPainted(true);
    });
    const mirror = new LocalFramebufferMirror(link.mirror);
    const stopWatch = mirror.watch(registry);

    return () => {
      stopWatch();
      offChange();
      detach?.();
      setLive(false);
      setPainted(false);
    };
  }, [link]);

  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, FALLBACK_ASPECT);

  return (
    <div
      className={`kshared-framebuffer${keeping ? " is-held" : ""}`}
      hidden={!showing}
    >
      <div className="kframebuffer-surface" ref={stageRef}>
        <canvas ref={canvasRef} className="kframebuffer-canvas" style={canvasStyle} />
      </div>
    </div>
  );
};
