// Modeset pane — mirrors the Framebuffer pane: never spawns the renderer,
// only attaches an OffscreenCanvas + stats SAB for the kernel-worker's
// vblank pump. Stats slot layout is set by tickVblank in kernel-worker.ts.

import * as React from "react";
import { useKernelHost, useStatus } from "../kernel-host/react";
import type { KmsDisplayHandle } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { injectChunkedMouseMotion, type MouseEventSink } from "@host/framebuffer/browser-controls";
import { DemoSurfaceDockControls } from "./Framebuffer";
import { useFittedCanvasStyle } from "./canvasFit";

// modeset.c hardcodes 1920×1080 (CANVAS_W/CANVAS_H). The kernel-side
// auto-attach resizes the OffscreenCanvas drawing buffer to match the
// FB before `getContext("webgl2")`, but the placeholder HTMLCanvas in
// the main thread keeps whatever `width`/`height` we set BEFORE
// `transferControlToOffscreen()`. We need correct attribute dims here
// so the pointer scaling math (`canvas.width / rect.width`) matches
// the framebuffer the wasm program actually paints into.
const MODESET_FB_W = 1920;
const MODESET_FB_H = 1080;

export interface ModesetProps {
  dragProps?: import("./PaneHead").PaneHeadDragProps;
  onCollapse?: () => void;
  onMaximize?: () => void;
  isMax?: boolean;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
  /** CRTC to bind the canvas to. Defaults to 1 (the single CRTC the
   *  kernel currently advertises via MODE_GETRESOURCES). */
  crtcId?: number;
}

interface KmsStats {
  width: number;
  height: number;
  commitCount: number;
  lastFrameUs: number;
}

const ZERO_STATS: KmsStats = {
  width: 0,
  height: 0,
  commitCount: 0,
  lastFrameUs: 0,
};

export const Modeset: React.FC<ModesetProps> = ({ crtcId = 1, onDockControlsChange }) => {
  const host = useKernelHost();
  const status = useStatus();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const handleRef = React.useRef<KmsDisplayHandle | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [stats, setStats] = React.useState<KmsStats>(ZERO_STATS);

  // Attach the canvas as soon as we have one and the kernel is up.
  React.useEffect(() => {
    if (status !== "running") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (handleRef.current) return;

    // Match the wasm program's framebuffer dims BEFORE
    // `transferControlToOffscreen()`. The placeholder HTMLCanvas keeps
    // these as its `.width`/`.height` attribute values after transfer;
    // the OffscreenCanvas inherits them too. Both matter:
    //   - The pointer scaler reads `canvas.width / rect.width` to map
    //     CSS deltas to framebuffer pixels. Default 300/150 would mean
    //     the cursor crawls at ~1/6 speed and Pavel's splats clump.
    //   - The OffscreenCanvas drawing buffer must be 1920×1080 so
    //     `glViewport(0, 0, 1920, 1080)` covers the full surface.
    if (canvas.width !== MODESET_FB_W) canvas.width = MODESET_FB_W;
    if (canvas.height !== MODESET_FB_H) canvas.height = MODESET_FB_H;

    try {
      const handle = host.attachKmsDisplay(canvas, crtcId);
      if (!handle) {
        setError("Kernel does not expose kmsAttachCanvas (older ABI?)");
        return;
      }
      handleRef.current = handle;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    return () => {
      handleRef.current?.close();
      handleRef.current = null;
    };
  }, [host, status, crtcId]);

  // Forward pointer motion + buttons into the kernel's `/dev/input/mice`.
  // Pointer events cover mouse, touch, and pen with one listener set; a
  // touch acts as a left-button mouse. The wasm side has no
  // absolute-cursor input — it integrates int8 deltas from PS/2 packets
  // — so we mirror the wasm cursor here and snap it to the OS pointer on
  // pointerenter (or a touch press). The snap cannot trust modeset.c's
  // initial midpoint: a machine adopted through a take-over restores its
  // cursor wherever the previous owner left it, and a teleport measured
  // from the wrong origin offsets every splat for the rest of the
  // session. So each snap first drives the cursor to the origin with a
  // full-frame negative sweep — `drain_mouse()` clamps every packet, so
  // the corner is reached from anywhere — and teleports from there.
  // Browser Y grows down, PS/2 dy is positive-up, so flip once in
  // `sendDelta`. Large jumps get chunked into legal i8 packets — without
  // that, a fast drag wraps `(int8_t)pkt[1]` and `drain_mouse()`
  // interprets it as the opposite direction.
  React.useEffect(() => {
    if (status !== "running") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let prevCanvasX: number | null = null;
    let prevCanvasY: number | null = null;
    let wasmCursorX = 0;
    let wasmCursorY = 0;
    let buttons = 0;
    let activeTouchId: number | null = null;
    const buttonBit = (button: number) =>
      button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;
    const sink: MouseEventSink = {
      injectMouseEvent: (dx, dy, bts) => {
        handleRef.current?.sendMouseEvent(dx, dy, bts);
      },
    };
    // Pointer capture keeps a drag streaming past the canvas edge, so
    // clamp to the FB bounds — drain_mouse() clamps the same way, and
    // an unclamped mirror would desync from the guest cursor there.
    const toCanvasCoords = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = rect.width > 0 ? ((clientX - rect.left) * canvas.width) / rect.width : 0;
      const y = rect.height > 0 ? ((clientY - rect.top) * canvas.height) / rect.height : 0;
      return {
        x: Math.min(canvas.width - 1, Math.max(0, x)),
        y: Math.min(canvas.height - 1, Math.max(0, y)),
      };
    };
    const sendDelta = (dx: number, dy: number) => {
      if (dx === 0 && dy === 0) return;
      injectChunkedMouseMotion(sink, dx, -dy, buttons);
      wasmCursorX = Math.min(canvas.width - 1, Math.max(0, wasmCursorX + dx));
      wasmCursorY = Math.min(canvas.height - 1, Math.max(0, wasmCursorY + dy));
    };
    const handlePointerAt = (canvasX: number, canvasY: number) => {
      if (prevCanvasX === null || prevCanvasY === null) {
        sendDelta(-canvas.width, -canvas.height);
        sendDelta(Math.round(canvasX - wasmCursorX), Math.round(canvasY - wasmCursorY));
      } else {
        sendDelta(Math.round(canvasX - prevCanvasX), Math.round(canvasY - prevCanvasY));
      }
      prevCanvasX = canvasX;
      prevCanvasY = canvasY;
    };
    const onPointerEnter = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const c = toCanvasCoords(e.clientX, e.clientY);
      handlePointerAt(c.x, c.y);
    };
    const onPointerLeave = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      prevCanvasX = null;
      prevCanvasY = null;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" && e.pointerId !== activeTouchId) return;
      const c = toCanvasCoords(e.clientX, e.clientY);
      handlePointerAt(c.x, c.y);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        // Track a single finger; a second finger would teleport the
        // cursor back and forth between touch points.
        if (activeTouchId !== null) return;
        activeTouchId = e.pointerId;
      }
      const bit = buttonBit(e.button);
      if (bit === 0) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === "touch") {
        // A finger moves and presses in one event; move the cursor to
        // the touch point first so the click lands under the finger,
        // not at the cursor's previous position.
        const c = toCanvasCoords(e.clientX, e.clientY);
        handlePointerAt(c.x, c.y);
      }
      buttons |= bit;
      handleRef.current?.sendMouseEvent(0, 0, buttons);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        if (e.pointerId !== activeTouchId) return;
        activeTouchId = null;
        prevCanvasX = null;
        prevCanvasY = null;
      }
      const bit = buttonBit(e.button);
      if (bit === 0) return;
      e.preventDefault();
      buttons &= ~bit;
      handleRef.current?.sendMouseEvent(0, 0, buttons);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (e.pointerType === "touch" && e.pointerId !== activeTouchId) return;
      activeTouchId = null;
      prevCanvasX = null;
      prevCanvasY = null;
      if (buttons === 0) return;
      buttons = 0;
      handleRef.current?.sendMouseEvent(0, 0, 0);
    };
    const onContextMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerenter", onPointerEnter);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    // Pointer capture routes up/cancel to the canvas even when the
    // pointer is released outside it, so button state clears without a
    // document-level mouseup listener.
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [status]);

  // Drain the stats SAB at 4 Hz. The numbers are advisory; rAF would
  // re-render every blit, which is overkill for a status panel.
  React.useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    const tick = () => {
      const s = handle.stats;
      setStats({
        width: Atomics.load(s, 2),
        height: Atomics.load(s, 3),
        commitCount: Atomics.load(s, 5),
        lastFrameUs: Atomics.load(s, 6),
      });
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [status, error]);

  const showCanvas = status === "running" && !error;
  const hasFrame = stats.width > 0 && stats.height > 0;
  const canvasStyle = useFittedCanvasStyle(stageRef, canvasRef, MODESET_FB_W / MODESET_FB_H);
  const statusLabel = hasFrame
    ? `${stats.width}×${stats.height} · ${stats.commitCount} flips · ${stats.lastFrameUs}µs`
    : "waiting for PAGE_FLIP";
  const dockControls = React.useMemo(() => (
    <DemoSurfaceDockControls
      title={`MODESET · /DEV/DRI/CARD0 · CRTC ${crtcId}`}
      status={statusLabel}
      active={hasFrame}
    />
  ), [crtcId, hasFrame, statusLabel]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  return (
    <div className="kmodeset-surface">
      <div className="kmodeset-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          className="kmodeset-canvas"
          style={{
            ...canvasStyle,
            display: showCanvas ? "block" : "none",
          }}
        />
        {showCanvas && !hasFrame && (
          <div className="kmodeset-waiting" role="status" aria-live="polite">
            <div className="kmodeset-waiting-line">Waiting for PAGE_FLIP on CRTC {crtcId}</div>
            <div className="kmodeset-waiting-line kmodeset-waiting-secondary">
              Run <code>modeset</code> from the shell.
            </div>
          </div>
        )}
        {(error || status !== "running") && (
          <div className="kmodeset-waiting" role="status" aria-live="polite">
            {error
              ? <>attachKmsDisplay failed: {error}</>
              : <>Waiting for the kernel to reach 'running'.</>}
          </div>
        )}
      </div>
    </div>
  );
};
