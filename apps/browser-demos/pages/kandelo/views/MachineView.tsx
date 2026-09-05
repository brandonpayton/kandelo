// MachineView — phase-aware demo presentation.
//
// During boot the machine shows syslog as the primary surface. Once the demo
// reaches the useful state, the primary surface follows the active profile:
// web preview for service demos, framebuffer for Doom, terminal for shell-like
// demos. The dock owns switching between demo, terminal, and internals views.

import * as React from "react";
import {
  useDemoGuide,
  usePresentation,
  useStatus,
  useSurfaceAvailability,
  useWebPreview,
} from "../kernel-host/react";
import { Inspector } from "../panes/Inspector";
import { Display, type DisplayHandle, type WordPressLoginOptions } from "../panes/Display";
import { Shell, type ShellTerminal } from "../panes/Shell";
import { DemoGuide } from "../panes/DemoGuide";
import type { DemoActionConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import type {
  DemoPresentation,
  MachineStatus,
  PrimarySurface,
  SurfaceAvailability,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

export type MachineSurfaceView = "demo" | "terminal" | "internals";

export interface MachineSurfaceController {
  status: MachineStatus;
  presentation: DemoPresentation;
  availability: SurfaceAvailability;
  activePrimary: PrimarySurface;
  activeView: MachineSurfaceView;
  primaryLabel: string;
  demoSurface: PrimarySurface | null;
  canOpenDemo: boolean;
  canUseTerminal: boolean;
  canUseInternals: boolean;
  shouldMountDemoSurface: boolean;
  choosePrimary: (surface: PrimarySurface) => void;
  chooseView: (view: MachineSurfaceView) => void;
  followDemoSurface: () => void;
  focusInternals: () => void;
}

export function useMachineSurfaceController(): MachineSurfaceController {
  const status = useStatus();
  const presentation = usePresentation();
  const rawAvailability = useSurfaceAvailability();
  const webPreview = useWebPreview();
  const availability = React.useMemo<SurfaceAvailability>(() => ({
    ...rawAvailability,
    web: rawAvailability.web && webPreview?.status === "running",
  }), [rawAvailability, webPreview?.status]);
  const [activePrimary, setActivePrimary] = React.useState<PrimarySurface>(presentation.bootPrimary);
  const [primaryMode, setPrimaryMode] = React.useState<"following-demo" | "pinned">("following-demo");
  const previousAvailability = React.useRef(availability);
  const canUseTerminal = status === "running" && availability.terminal;

  const defaultPrimary = React.useMemo<PrimarySurface>(() => {
    if (status !== "running") {
      return isSurfaceAvailable(presentation.bootPrimary, availability)
        ? presentation.bootPrimary
        : "syslog";
    }
    return resolvePrimary(presentation.runningPrimary, availability, presentation.bootPrimary);
  }, [availability, presentation, status]);

  React.useEffect(() => {
    if (status !== "running" || primaryMode === "following-demo" || !isSurfaceAvailable(activePrimary, availability)) {
      setActivePrimary(defaultPrimary);
    }
  }, [activePrimary, availability, defaultPrimary, primaryMode, status]);

  React.useEffect(() => {
    const previous = previousAvailability.current;
    previousAvailability.current = availability;
    if (status !== "running") return;
    if (activePrimary !== "terminal") return;
    const preferred = presentation.runningPrimary[0];
    if (!preferred || preferred === "terminal") return;
    if (previous[preferred] || !availability[preferred]) return;

    setActivePrimary(preferred);
    setPrimaryMode("following-demo");
  }, [activePrimary, availability, presentation.runningPrimary, status]);

  React.useEffect(() => {
    setPrimaryMode("following-demo");
  }, [presentation.runningPrimary, presentation.autoCommand]);

  const choosePrimary = React.useCallback((surface: PrimarySurface) => {
    if (status !== "running" && surface !== "syslog") return;
    if (!isSurfaceAvailable(surface, availability)) return;
    setActivePrimary(surface);
    setPrimaryMode(surface === defaultPrimary ? "following-demo" : "pinned");
  }, [availability, defaultPrimary, status]);

  const demoSurface = React.useMemo(
    () => resolveDemoSurface(presentation.runningPrimary),
    [presentation.runningPrimary],
  );
  const canOpenDemo =
    demoSurface !== null &&
    isSurfaceAvailable(demoSurface, availability) &&
    status === "running";
  const shouldMountDemoSurface =
    demoSurface !== null &&
    status === "running" &&
    isSurfaceAvailable(demoSurface, availability);
  const canUseInternals = status !== "idle" && isSurfaceAvailable("syslog", availability);

  const chooseView = React.useCallback((view: MachineSurfaceView) => {
    if (view === "demo") {
      if (demoSurface) choosePrimary(demoSurface);
      return;
    }
    choosePrimary(view === "terminal" ? "terminal" : "syslog");
  }, [choosePrimary, demoSurface]);

  const followDemoSurface = React.useCallback(() => {
    if (!demoSurface) return;
    setActivePrimary(demoSurface);
    setPrimaryMode("following-demo");
  }, [demoSurface]);

  const focusInternals = React.useCallback(() => {
    setActivePrimary("syslog");
    setPrimaryMode("pinned");
  }, []);

  const activeView: MachineSurfaceView =
    activePrimary === "terminal"
      ? "terminal"
      : activePrimary === "syslog"
        ? "internals"
        : "demo";

  return {
    status,
    presentation,
    availability,
    activePrimary,
    activeView,
    primaryLabel: surfaceLabel(activePrimary),
    demoSurface,
    canOpenDemo,
    canUseTerminal,
    canUseInternals,
    shouldMountDemoSurface,
    choosePrimary,
    chooseView,
    followDemoSurface,
    focusInternals,
  };
}

export interface MachineViewProps {
  surface: MachineSurfaceController;
  demoGuideOpen: boolean;
  onDemoGuideOpenChange: (open: boolean) => void;
  onDemoDockControlsChange: (controls: React.ReactNode | null) => void;
  onDemoGuidePopupChange: (popup: React.ReactNode | null) => void;
  internalsTab: string;
  terminals: ShellTerminal[];
  activeTerminalId: string;
  onActiveTerminalId: (id: string) => void;
  onAddTerminal: () => void;
  onPreviewPathChange?: (path: string) => void;
  previewViewerPath?: string | null;
  /** Reloads the web preview when it changes, so a recording that just
   *  started carries the exchanges behind the page the user is on. */
  previewReloadToken?: number;
}

export const MachineView: React.FC<MachineViewProps> = ({
  surface,
  demoGuideOpen,
  onDemoGuideOpenChange,
  onDemoDockControlsChange,
  onDemoGuidePopupChange,
  internalsTab,
  terminals,
  activeTerminalId,
  onActiveTerminalId,
  onAddTerminal,
  onPreviewPathChange,
  previewViewerPath,
  previewReloadToken,
}) => {
  const demoGuide = useDemoGuide();
  const displayRef = React.useRef<DisplayHandle | null>(null);

  React.useEffect(() => {
    if (!previewReloadToken) return;
    displayRef.current?.reloadPreview();
  }, [previewReloadToken]);
  const {
    activePrimary,
    demoSurface,
    canUseTerminal,
    shouldMountDemoSurface,
    followDemoSurface,
    chooseView,
  } = surface;

  const runWebAction = React.useCallback(async (action: DemoActionConfig): Promise<string | void> => {
    if (action.kind === "web.wordpressLogin") {
      followDemoSurface();
      const preview = displayRef.current;
      if (!preview) throw new Error("Web preview is not available");
      await preview.loginToWordPress(parseWordPressLoginPayload(action.payload));
      return "Logged into WordPress";
    }
    throw new Error(`Unsupported web action: ${action.kind}`);
  }, [followDemoSurface]);

  const shellProps = {
    terminals,
    activeTerminalId,
    onActiveTerminalId,
    onAddTerminal,
  };

  const showDemoGuide = demoGuide !== null && demoGuideOpen;

  React.useEffect(() => {
    if (!shouldMountDemoSurface) onDemoDockControlsChange(null);
  }, [onDemoDockControlsChange, shouldMountDemoSurface]);

  const openTerminalFromGuide = React.useCallback(() => {
    if (canUseTerminal) chooseView("terminal");
  }, [canUseTerminal, chooseView]);

  const demoGuidePopup = React.useMemo(() => {
    if (!showDemoGuide) return null;
    return (
      <DemoGuide
        onClose={() => onDemoGuideOpenChange(false)}
        onOpenTerminal={openTerminalFromGuide}
        onRunWebAction={runWebAction}
      />
    );
  }, [onDemoGuideOpenChange, openTerminalFromGuide, runWebAction, showDemoGuide]);

  React.useEffect(() => {
    onDemoGuidePopupChange(demoGuidePopup);
    return () => onDemoGuidePopupChange(null);
  }, [demoGuidePopup, onDemoGuidePopupChange]);

  return (
    <div className="kmachine">
      <div className="kmachine-workspace">
        <div className="kmachine-primary">
          {shouldMountDemoSurface && (
            <PrimarySurfaceSlot active={activePrimary === demoSurface}>
              <Display
                ref={displayRef}
                autoFocus={activePrimary === demoSurface}
                surface={demoSurface ?? undefined}
                onDockControlsChange={onDemoDockControlsChange}
                onPreviewPathChange={onPreviewPathChange}
                previewViewerPath={previewViewerPath}
              />
            </PrimarySurfaceSlot>
          )}
          {activePrimary === "terminal" && canUseTerminal && (
            <PrimarySurfaceSlot active>
              <Shell autoFocus {...shellProps} />
            </PrimarySurfaceSlot>
          )}
          {activePrimary === "syslog" && (
            <PrimarySurfaceSlot active>
              <Inspector tab={internalsTab} />
            </PrimarySurfaceSlot>
          )}
        </div>
      </div>
    </div>
  );
};

function parseWordPressLoginPayload(payload: string): WordPressLoginOptions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = {};
  }
  const value = typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : {};
  return {
    username: typeof value.username === "string" ? value.username : "admin",
    password: typeof value.password === "string" ? value.password : "password",
    loginPath: typeof value.loginPath === "string" ? value.loginPath : "/wp-login.php",
    adminPath: typeof value.adminPath === "string" ? value.adminPath : "/wp-admin/",
  };
}

const PrimarySurfaceSlot: React.FC<{
  active: boolean;
  children: React.ReactNode;
}> = ({ active, children }) => (
  <div className={`kmachine-primary-slot${active ? "" : " is-hidden"}`} aria-hidden={!active}>
    {children}
  </div>
);

function surfaceLabel(surface: PrimarySurface): string {
  switch (surface) {
    case "terminal": return "Terminal";
    case "framebuffer": return "Framebuffer";
    case "web": return "Web Preview";
    case "kms": return "Modeset";
    case "syslog": return "System Internals";
  }
}

function resolvePrimary(
  preferences: readonly PrimarySurface[],
  availability: SurfaceAvailability,
  fallback: PrimarySurface,
): PrimarySurface {
  return preferences.find((surface) => isSurfaceAvailable(surface, availability)) ?? fallback;
}

function resolveDemoSurface(preferences: readonly PrimarySurface[]): PrimarySurface | null {
  return preferences.find((surface) =>
    surface === "web" || surface === "framebuffer" || surface === "kms",
  ) ?? null;
}

function isSurfaceAvailable(surface: PrimarySurface, availability: SurfaceAvailability): boolean {
  return availability[surface] === true;
}
