// Top-level Kandelo app. The machine remains the primary canvas; the dock
// switches machine views and opens exploratory panes for gallery and overlays.

import * as React from "react";
import { useDemoGuide, useKernelHost, useLazyDownloads } from "../kernel-host/react";
import { Dock, DockPane, type DockLayoutState, type DockPaneId, type DockViewId } from "./Dock";
import { MachineView, useMachineSurfaceController } from "../views/MachineView";
import { descriptorFromGalleryItem } from "../gallery-descriptor";
import { Gallery } from "../views/Gallery";
import { EmptyState } from "../views/EmptyState";
import { createShellTerminal, type ShellTerminal } from "../panes/Shell";
import { SharedMachine } from "../panes/SharedMachine";
import { NetworkPopup } from "./NetworkPopup";
import { useMachineHandover } from "./machine-handover";
import { useMachineReplication } from "./machine-replication";
import { usePeerSession } from "./peer-session";
import { useFramebufferPublisher } from "./shared-framebuffer";
import { useTerminalPublisher } from "./shared-terminal";
import { Inspector, INSPECTOR_TABS } from "../panes/Inspector";
import { navigateToGalleryItemUrl, replaceGalleryItemUrl } from "../url-state";
import type {
  BootDescriptor,
  GalleryItem,
  LazyDownloadEvent,
  MachineAudioState,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { lazyDownloadAssetLabel } from "../../../../../web-libs/kandelo-session/src/lazy-download";
import { TerminalDockControls } from "./TerminalDockControls";

type InternalsTab = "syslog" | "procs" | "vfs" | "lazy-load" | "config" | "syscalls";
type ThemeFamily = "ubuntu" | "wordpress" | "kandelo";
type ResolvedThemeMode = "light" | "dark";
type ThemeMode = ResolvedThemeMode | "auto";
type ThemePreference = {
  family: ThemeFamily;
  mode: ThemeMode;
};

const THEME_STORAGE_KEY = "kandelo.theme";
const DEMO_GUIDE_SEEN_STORAGE_KEY = "kandelo.demo-guide.seen";
const THEME_STORAGE_VERSION = 4;

type StoredThemePreference = ThemePreference & {
  version: typeof THEME_STORAGE_VERSION;
};

const DEFAULT_THEME: ThemePreference = { family: "kandelo", mode: "auto" };
const THEME_FAMILIES: Array<{ family: ThemeFamily; label: string; description: string }> = [
  { family: "kandelo", label: "Kandelo", description: "Candlelit Kandelo surfaces with warm highlights and ink-dark contrast." },
  { family: "wordpress", label: "WordPress", description: "WordPress design-system grays with the modern blueberry accent." },
  { family: "ubuntu", label: "Ubuntu", description: "Yaru light and dark colors with Ubuntu terminal palettes." },
];
const THEME_MODES: Array<{ mode: ThemeMode; label: string }> = [
  { mode: "auto", label: "Auto" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

const PANE_META: Record<DockPaneId, { title: string; subtitle: string }> = {
  gallery: {
    title: "Launch New Machine",
    subtitle: "Choose a published Kandelo machine or local demo image to boot.",
  },
};

export const App: React.FC = () => {
  const host = useKernelHost();
  const demoGuide = useDemoGuide();
  const lazyDownloads = useLazyDownloads();
  const surface = useMachineSurfaceController();
  const peer = usePeerSession();

  const [dockPane, setDockPane] = React.useState<DockPaneId | null>(null);
  const [dockHeight, setDockHeight] = React.useState(0);
  const [dockLayout, setDockLayout] = React.useState<DockLayoutState>({ collapsed: false, fullWidth: true });
  const [demoGuideOpen, setDemoGuideOpen] = React.useState(false);
  const [demoDockControls, setDemoDockControls] = React.useState<React.ReactNode | null>(null);
  const [demoGuidePopup, setDemoGuidePopup] = React.useState<React.ReactNode | null>(null);
  const [internalsOpen, setInternalsOpen] = React.useState(false);
  const [internalsTab, setInternalsTab] = React.useState<InternalsTab>("syslog");
  const [networkOpen, setNetworkOpen] = React.useState(false);
  const [theme, setTheme] = React.useState<ThemePreference>(() => readThemePreference());
  const [systemThemeMode, setSystemThemeMode] = React.useState<ResolvedThemeMode>(() => getSystemThemeMode());
  const [themeOpen, setThemeOpen] = React.useState(false);
  const [terminals, setTerminals] = React.useState<ShellTerminal[]>(() => [createShellTerminal(1)]);
  const [activeTerminalId, setActiveTerminalId] = React.useState("tty-1");
  const [audioState, setAudioState] = React.useState<MachineAudioState>(() => host.getAudioState());
  const [audioError, setAudioError] = React.useState<string | null>(null);
  const nextTerminalIndex = React.useRef(2);
  const autoOpenedDemoGuideKey = React.useRef<string | null>(null);

  // One machine sends one surface: the one the person holding it is looking
  // at. A machine that published everything it drives would leave the watching
  // computer with a screen and a shell stacked in one column, with nothing
  // saying which of them the other person is using.
  const presenting = surface.status === "running" ? surface.activePrimary : null;
  const terminalSharing = useTerminalPublisher(
    host,
    peer.link,
    terminals.find((terminal) => terminal.id === activeTerminalId)?.path,
    presenting === "terminal",
  );
  const sharingScreen = useFramebufferPublisher(
    host,
    peer.link,
    presenting === "framebuffer",
  );
  // Replication first: a viewer running a replica is still a viewer, and the
  // handover must not offer that replica as a second machine to take.
  const replication = useMachineReplication(host, peer.link);
  const handover = useMachineHandover(host, peer.link, replication.replicating);

  const [previewReloadToken, setPreviewReloadToken] = React.useState(0);
  React.useEffect(() => {
    if (!replication.publishing) return;
    // The recording started after the page the user is on was fetched, so
    // its exchanges are not in the log. A reload re-fetches them through the
    // bridge, into the recording, so the viewer has something to render.
    setPreviewReloadToken((token) => token + 1);
  }, [replication.publishing]);

  const desc = host.getBootDescriptor();
  const resolvedThemeMode = theme.mode === "auto" ? systemThemeMode : theme.mode;

  React.useEffect(
    () => host.subscribeAudioState((state) => {
      setAudioState(state);
      if (state === "running") setAudioError(null);
    }),
    [host],
  );

  const activateAudio = React.useCallback(() => {
    if (host.getAudioState() === "running") return;
    void host.resumeAudio().then(
      () => setAudioError(null),
      (error) => setAudioError(error instanceof Error ? error.message : String(error)),
    );
  }, [host]);

  // Web Audio starts only after a trusted gesture. Keep activation at the
  // machine shell so terminal-only SDL applications use the same PCM sink.
  React.useEffect(() => {
    window.addEventListener("pointerdown", activateAudio, { capture: true });
    window.addEventListener("keydown", activateAudio, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", activateAudio, { capture: true });
      window.removeEventListener("keydown", activateAudio, { capture: true });
    };
  }, [activateAudio]);

  React.useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemThemeMode(query.matches ? "dark" : "light");
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.kTheme = theme.family;
    root.dataset.kMode = resolvedThemeMode;
    root.dataset.kModePreference = theme.mode;
    root.style.colorScheme = resolvedThemeMode;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
        ...theme,
        version: THEME_STORAGE_VERSION,
      } satisfies StoredThemePreference));
    } catch {
      // User preference storage can be unavailable in private or restricted contexts.
    }
  }, [resolvedThemeMode, theme]);

  React.useEffect(() => {
    const key = `${desc.id}:${demoGuide?.title ?? "no-guide"}`;
    if (autoOpenedDemoGuideKey.current === key) return;
    autoOpenedDemoGuideKey.current = key;
    // A replica's descriptor is the other computer's launch, not this
    // person's; its guide would cover the machine they were already watching.
    // A guide this browser has already auto-opened stays closed: a machine
    // that reloads is not a new demo, and the dock button still opens it.
    const replicaBoot = replication.joining || replication.replicating;
    const open = dockPane === null && demoGuide !== null && !replicaBoot
      && !hasSeenDemoGuide(key);
    setDemoGuideOpen(open);
    if (open) rememberSeenDemoGuide(key);
  }, [
    demoGuide?.title,
    desc.id,
    dockPane,
    replication.joining,
    replication.replicating,
  ]);

  React.useEffect(() => {
    setDemoDockControls(null);
    setDemoGuidePopup(null);
    setInternalsOpen(false);
    setNetworkOpen(false);
    setThemeOpen(false);
  }, [desc.id]);

  // The popup exists to buy a connection. Once there is one it is covering the
  // machine it was opened to share, so it gets out of the way; the Network
  // button stays lit and reopens it for the controls that outlive the codes.
  React.useEffect(() => {
    if (peer.link) setNetworkOpen(false);
  }, [peer.link]);

  const closeDockPane = React.useCallback(() => {
    setDockPane(null);
  }, []);

  const selectDockPane = React.useCallback((pane: DockPaneId | null) => {
    setInternalsOpen(false);
    setDemoGuideOpen(false);
    setNetworkOpen(false);
    setThemeOpen(false);
    setDockPane((current) => current === pane ? null : pane);
  }, []);

  const selectMachineView = React.useCallback((view: DockViewId) => {
    setDockPane(null);
    setInternalsOpen(false);
    setNetworkOpen(false);
    setThemeOpen(false);
    surface.chooseView(view);
  }, [surface]);

  const toggleDemoGuide = React.useCallback(() => {
    if (!demoGuide) return;
    setDockPane(null);
    setInternalsOpen(false);
    setNetworkOpen(false);
    setThemeOpen(false);
    setDemoGuideOpen((open) => !open);
  }, [demoGuide]);

  const toggleInternals = React.useCallback(() => {
    if (!surface.canUseInternals) return;
    setDockPane(null);
    setDemoGuideOpen(false);
    setNetworkOpen(false);
    setThemeOpen(false);
    setInternalsOpen((open) => !open);
  }, [surface.canUseInternals]);

  const toggleNetwork = React.useCallback(() => {
    setDockPane(null);
    setDemoGuideOpen(false);
    setInternalsOpen(false);
    setThemeOpen(false);
    setNetworkOpen((open) => !open);
  }, []);

  const toggleTheme = React.useCallback(() => {
    setDockPane(null);
    setDemoGuideOpen(false);
    setInternalsOpen(false);
    setNetworkOpen(false);
    setThemeOpen((open) => !open);
  }, []);

  const applyDescriptor = React.useCallback((d: BootDescriptor) => {
    void host.applyBootDescriptor(d).then(closeDockPane).catch((err) => {
      console.warn("applyBootDescriptor failed:", err);
    });
  }, [host, closeDockPane]);

  const onLaunchGalleryItem = React.useCallback((item: GalleryItem) => {
    void (async () => {
      let vfsImageUrl = item.vfsImageUrl;
      if (!vfsImageUrl && item.resolveVfsImageUrl) {
        try {
          vfsImageUrl = await item.resolveVfsImageUrl();
        } catch (err) {
          // Applying the descriptor below lets the host surface the same
          // missing-artifact error through its normal boot diagnostics.
          console.warn("resolveVfsImageUrl failed:", err);
        }
      }
      const launched = vfsImageUrl ? { ...item, vfsImageUrl } : item;
      // A connected computer boots in place. Navigating would close the peer
      // connection this document holds, and the two people would have to
      // exchange invite codes again to get it back.
      if (vfsImageUrl && peer.link === null) {
        navigateToGalleryItemUrl(launched);
        return;
      }

      const next = descriptorFromGalleryItem(launched, host.getBootDescriptor());
      await host.applyBootDescriptor(next);
      if (vfsImageUrl) replaceGalleryItemUrl(launched);
      closeDockPane();
    })().catch((err) => {
      console.warn("applyBootDescriptor failed:", err);
    });
  }, [host, closeDockPane, peer.link]);

  const onAddTerminal = React.useCallback(() => {
    const terminal = createShellTerminal(nextTerminalIndex.current++);
    setTerminals((prev) => [...prev, terminal]);
    setActiveTerminalId(terminal.id);
  }, []);

  const onRemoveTerminalId = React.useCallback((id: string) => {
    const removedIndex = terminals.findIndex((terminal) => terminal.id === id);
    if (removedIndex < 0 || terminals.length <= 1) return;
    const next = terminals.filter((terminal) => terminal.id !== id);
    setTerminals(next);
    setActiveTerminalId((active) =>
      active === id
        ? next[Math.min(removedIndex, next.length - 1)]!.id
        : active
    );
  }, [terminals]);

  const isEmpty = surface.status === "idle";
  const dockActiveView: DockViewId | null = !isEmpty && surface.activeView !== "internals"
    ? surface.activeView
    : null;
  const viewControls = !isEmpty
    ? surface.activeView === "demo"
      ? demoDockControls
      : surface.activeView === "terminal"
        ? (
          <TerminalDockControls
            terminals={terminals}
            activeTerminalId={activeTerminalId}
            onActiveTerminalId={setActiveTerminalId}
            onAddTerminal={onAddTerminal}
            onRemoveTerminalId={onRemoveTerminalId}
          />
        )
        : null
    : null;
  const internalsPopup = !isEmpty && internalsOpen && surface.canUseInternals
    ? (
      <InternalsPopup
        activeTab={internalsTab}
        onTab={(tab) => setInternalsTab(tab as InternalsTab)}
      />
    )
    : null;
  const meta = dockPane ? PANE_META[dockPane] : null;
  const appStyle = {
    "--kdock-height": `${dockHeight}px`,
  } as React.CSSProperties;
  const isTerminalView = !isEmpty && surface.activeView === "terminal";
  const reserveDockSpace = isTerminalView || dockLayout.fullWidth;
  const appClassName = [
    "kapp",
    "kdocked-app",
    isTerminalView ? "is-terminal-view" : "",
    dockLayout.fullWidth ? "is-dock-full-width" : "is-dock-sliding",
    dockLayout.collapsed ? "is-dock-collapsed" : "",
    reserveDockSpace ? "is-dock-space-reserved" : "is-dock-overlay",
  ].filter(Boolean).join(" ");
  const onDockLayoutChange = React.useCallback((layout: DockLayoutState) => {
    setDockLayout((current) => (
      current.collapsed === layout.collapsed && current.fullWidth === layout.fullWidth
        ? current
        : layout
    ));
  }, []);
  // Taken at the moment a machine leaves or starts on its way here, and held
  // until one is drawing again. Reading it on every render would re-join the
  // screen bytes each time; reading it once, when the move begins, is the only
  // moment its value can change.
  //
  // Both directions need it. The computer giving a machine up keeps the screen
  // it was showing. The computer taking one keeps the screen it was watching,
  // because a taker has to boot the image before the checkpoint can restore
  // into it, and the boot log is not what the person asked to see.
  const lastSharedScreen = terminalSharing.lastScreen;
  const moving = handover.handedOver || handover.taking;
  const held = React.useMemo(
    () => moving ? lastSharedScreen() : null,
    [moving, lastSharedScreen],
  );

  // One landing page, used both on its own and as what a connected computer
  // shows while the other one is sharing nothing.
  const emptyState = (
    <EmptyState
      onLaunchItem={onLaunchGalleryItem}
      onBrowseAll={() => setDockPane("gallery")}
      onApplyDescriptor={applyDescriptor}
      peerNote={peer.link
        ? handover.handedOver
          ? "You handed this machine over. It is starting on the other computer."
          : "Connected. Waiting for the other computer to share a screen."
        : null}
      watching={peer.link !== null}
    />
  );

  return (
    <div className={appClassName} style={appStyle} data-audio-state={audioState}>
      <main className={`kmain kdocked-main${isEmpty ? " kmain-flush" : ""}`}>
        {(isEmpty || handover.taking || replication.joining) && peer.link ? (
          // While a machine is arriving, this pane stays up over the boot that
          // is running behind it. `taking` ends when `adoptMachine` resolves,
          // and `joining` when `replicateMachine` does — both after the
          // checkpoint has restored, so the swap happens when there is a live
          // screen to swap to.
          <SharedMachine
            link={peer.link}
            moving={moving}
            held={held}
            idle={emptyState}
          />
        ) : isEmpty ? (
          emptyState
        ) : (
          <MachineView
            surface={surface}
            demoGuideOpen={demoGuideOpen}
            onDemoGuideOpenChange={setDemoGuideOpen}
            onDemoDockControlsChange={setDemoDockControls}
            onDemoGuidePopupChange={setDemoGuidePopup}
            internalsTab={internalsTab}
            terminals={terminals}
            activeTerminalId={activeTerminalId}
            onActiveTerminalId={setActiveTerminalId}
            onAddTerminal={onAddTerminal}
            onPreviewPathChange={
              replication.publishing ? replication.navigation.publish : undefined
            }
            previewViewerPath={
              replication.replicating
                ? replication.navigation.viewerPath
                : undefined
            }
            onPreviewCursorChange={
              replication.publishing ? replication.cursor.publish : undefined
            }
            previewViewerCursor={
              replication.replicating ? replication.cursor.viewerCursor : null
            }
            onPreviewScrollChange={
              replication.publishing ? replication.scroll.publish : undefined
            }
            previewViewerScroll={
              replication.replicating ? replication.scroll.viewerScroll : null
            }
            previewReloadToken={previewReloadToken}
          />
        )}
      </main>

      {dockPane && meta && (
        <>
          <div
            className="kdock-pane-dismiss-layer"
            aria-hidden="true"
            onPointerDown={closeDockPane}
          />
          <DockPane
            pane={dockPane}
            title={meta.title}
            subtitle={meta.subtitle}
            onClose={closeDockPane}
          >
            {dockPane === "gallery" && (
              <Gallery
                compact
                onLaunch={onLaunchGalleryItem}
              />
            )}
          </DockPane>
        </>
      )}

      <LazyDownloadToasts downloads={lazyDownloads} />
      {surface.status === "running" && audioState !== "running" && (
        <AudioStatusToast
          state={audioState}
          error={audioError}
          onEnable={activateAudio}
        />
      )}

      <Dock
        activePane={dockPane}
        activeView={dockActiveView}
        viewControls={viewControls}
        guidePopup={demoGuidePopup}
        internalsPopup={internalsPopup}
        networkPopup={
          <NetworkPopup
            session={peer}
            sharingTerminal={terminalSharing.sharing}
            sharingScreen={sharingScreen}
            handover={handover}
            canTakeMachine={
              (isEmpty || replication.replicating)
              && !replication.joining
              && handover.peerHasMachine
            }
            hasMachine={!isEmpty}
            presenting={presenting}
            replication={replication}
          />
        }
        themePopup={<ThemePopup theme={theme} resolvedMode={resolvedThemeMode} onThemeChange={setTheme} />}
        guideAvailable={!isEmpty && demoGuide !== null}
        guideOpen={!isEmpty && demoGuide !== null && demoGuideOpen}
        internalsAvailable={!isEmpty && surface.canUseInternals}
        internalsOpen={!isEmpty && surface.canUseInternals && internalsOpen}
        networkOpen={networkOpen}
        networkConnected={peer.link !== null}
        // Only in a pair. A computer on its own is neither, and one machine
        // with one person at it needs no word for that.
        role={
          peer.link === null
            ? null
            : isEmpty || replication.replicating
              ? "viewer"
              : "user"
        }
        themeOpen={themeOpen}
        // A machine on its way here is booting, whatever the surface it is
        // replacing happens to be doing. During a take-over the departing
        // replica still reports "running", and showing that beside a role
        // that already says "user" would claim a typeable machine before
        // there is one: the arriving image boots and restores first, and the
        // dock says "Running" when that machine is the one running.
        status={handover.taking || replication.joining ? "booting" : surface.status}
        machineTitle={isEmpty ? "Kandelo" : desc.title}
        viewDisabled={{
          demo: !surface.canOpenDemo,
          terminal: !surface.canUseTerminal,
        }}
        onSelectPane={selectDockPane}
        onSelectView={selectMachineView}
        onToggleGuide={toggleDemoGuide}
        onToggleInternals={toggleInternals}
        onToggleNetwork={toggleNetwork}
        onToggleTheme={toggleTheme}
        onCloseGuide={() => setDemoGuideOpen(false)}
        onCloseInternals={() => setInternalsOpen(false)}
        onCloseNetwork={() => setNetworkOpen(false)}
        onCloseTheme={() => setThemeOpen(false)}
        onHeightChange={setDockHeight}
        onLayoutChange={onDockLayoutChange}
      />
    </div>
  );
};

const AudioStatusToast: React.FC<{
  state: MachineAudioState;
  error: string | null;
  onEnable: () => void;
}> = ({ state, error, onEnable }) => {
  const detail = error ?? (
    state === "interrupted"
      ? "Audio output was interrupted by the browser or operating system."
      : state === "unavailable"
      ? "This browser does not provide the required Web Audio output."
      : state === "error"
      ? "The browser audio sink could not be started."
      : "Browser policy pauses audio until you interact with this machine."
  );
  return (
    <aside className="kdownload-toasts kpcm-audio-status" aria-label="Audio status" aria-live="polite">
      <div className={`kdownload-toast${error || state === "error" ? " kpcm-audio-error" : ""}`}>
        <div className="kdownload-toast-top">
          <span className="kdownload-toast-title">Audio {state}</span>
          {state !== "unavailable" && state !== "closed" && (
            <button type="button" className="kpcm-audio-enable" onClick={onEnable}>
              Enable
            </button>
          )}
        </div>
        <div className="kdownload-toast-detail">{detail}</div>
      </div>
    </aside>
  );
};

const InternalsPopup: React.FC<{
  activeTab: string;
  onTab: (id: string) => void;
}> = ({ activeTab, onTab }) => (
  <div className="kinternals-popup">
    <div className="kinternals-tabs" role="tablist" aria-label="Internals sections">
      {INSPECTOR_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className="kinternals-tab"
          role="tab"
          aria-selected={tab.id === activeTab}
          onClick={() => onTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
    <Inspector tab={activeTab} showTitle={false} />
  </div>
);

const ThemePopup: React.FC<{
  theme: ThemePreference;
  resolvedMode: ResolvedThemeMode;
  onThemeChange: React.Dispatch<React.SetStateAction<ThemePreference>>;
}> = ({ theme, resolvedMode, onThemeChange }) => (
  <div className="ktheme-popup">
    <section className="ktheme-section" aria-labelledby="ktheme-family-label">
      <div id="ktheme-family-label" className="ktheme-label">Palette</div>
      <div className="ktheme-options" role="radiogroup" aria-labelledby="ktheme-family-label">
        {THEME_FAMILIES.map((item) => (
          <button
            key={item.family}
            type="button"
            className="ktheme-option"
            data-family={item.family}
            role="radio"
            aria-checked={theme.family === item.family}
            onClick={() => onThemeChange((current) => ({ ...current, family: item.family }))}
          >
            <span className="ktheme-swatch" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="ktheme-copy">
              <span className="ktheme-name">{item.label}</span>
              <span className="ktheme-desc">{item.description}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
    <section className="ktheme-section" aria-labelledby="ktheme-mode-label">
      <div id="ktheme-mode-label" className="ktheme-label">Mode</div>
      <div className="ktheme-mode-row">
        {THEME_MODES.map((item) => {
          const autoResolved = theme.mode === "auto" && item.mode === resolvedMode;
          return (
            <button
              key={item.mode}
              type="button"
              className="ktheme-mode-button"
              aria-label={autoResolved ? `${item.label}, current system mode` : item.label}
              aria-pressed={theme.mode === item.mode}
              data-auto-resolved={autoResolved ? "true" : undefined}
              onClick={() => onThemeChange((current) => ({ ...current, mode: item.mode }))}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </section>
  </div>
);

const LazyDownloadToasts: React.FC<{
  downloads: LazyDownloadEvent[];
}> = ({ downloads }) => {
  const [dismissed, setDismissed] = React.useState<Set<string>>(() => new Set());
  const visibleDownloads = React.useMemo(
    () => downloads.filter((download) => !dismissed.has(download.id)),
    [dismissed, downloads],
  );

  React.useEffect(() => {
    setDismissed((current) => {
      if (current.size === 0) return current;
      const activeIds = new Set(downloads.map((download) => download.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (activeIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [downloads]);

  const dismiss = React.useCallback((id: string) => {
    setDismissed((current) => new Set(current).add(id));
  }, []);

  if (visibleDownloads.length === 0) return null;

  return (
    <aside className="kdownload-toasts" aria-label="Download status" aria-live="polite">
      {visibleDownloads.slice(0, 3).map((download) => (
        <LazyDownloadToast key={download.id} download={download} onDismiss={dismiss} />
      ))}
      {visibleDownloads.length > 3 && (
        <div className="kdownload-toast kdownload-toast-overflow">
          <span className="kdownload-toast-title">More downloads</span>
          <span className="kdownload-toast-detail">+{visibleDownloads.length - 3} active</span>
        </div>
      )}
    </aside>
  );
};

const LazyDownloadToast: React.FC<{
  download: LazyDownloadEvent;
  onDismiss: (id: string) => void;
}> = ({ download, onDismiss }) => {
  const pct = download.totalBytes && download.totalBytes > 0
    ? Math.min(100, Math.max(0, (download.loadedBytes / download.totalBytes) * 100))
    : null;
  const label = lazyDownloadAssetLabel(download);
  const progressLabel = downloadProgressLabel(download, pct);
  const title = `${downloadStatusVerb(download)} ${label}`;
  const detail = `${humanBytes(download.loadedBytes)}${
    download.totalBytes ? ` / ${humanBytes(download.totalBytes)}` : ""
  }`;

  return (
    <div
      className={`kdownload-toast kdownload-toast-${download.status}`}
      title={download.error ? `${title}: ${download.error}` : `${title} (${detail})`}
    >
      <div className="kdownload-toast-top">
        <span className="kdownload-toast-title">{title}</span>
        <span className="kdownload-toast-progress-label">{progressLabel}</span>
        <button
          type="button"
          className="kdownload-toast-close"
          aria-label={`Dismiss ${label} download status`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onDismiss(download.id);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3 3l6 6" />
            <path d="M9 3 3 9" />
          </svg>
        </button>
      </div>
      <div className="kdownload-toast-detail">
        {download.error ?? detail}
      </div>
      <div className={`kdownload-toast-bar${pct === null ? " indeterminate" : ""}`} aria-hidden="true">
        <span style={{ width: pct === null ? "44%" : `${pct}%` }} />
      </div>
    </div>
  );
};

function downloadStatusVerb(event: LazyDownloadEvent): string {
  switch (event.status) {
    case "complete": return "Downloaded";
    case "error": return "Failed";
    default: return "Downloading";
  }
}

function downloadProgressLabel(event: LazyDownloadEvent, pct: number | null): string {
  if (event.status === "complete") return "OK";
  if (event.status === "error") return "ERR";
  return pct === null ? "..." : `${Math.round(pct)}%`;
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib < 10 ? 1 : 0)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib < 10 ? 1 : 0)} MiB`;
}

function hasSeenDemoGuide(key: string): boolean {
  try {
    const raw = window.localStorage.getItem(DEMO_GUIDE_SEEN_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.includes(key);
  } catch {
    return false;
  }
}

function rememberSeenDemoGuide(key: string): void {
  try {
    const raw = window.localStorage.getItem(DEMO_GUIDE_SEEN_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const seen = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
    if (seen.includes(key)) return;
    seen.push(key);
    window.localStorage.setItem(
      DEMO_GUIDE_SEEN_STORAGE_KEY,
      JSON.stringify(seen),
    );
  } catch {
    // User preference storage can be unavailable in private or restricted contexts.
  }
}

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return DEFAULT_THEME;

  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<StoredThemePreference>;
    if (
      parsed.version !== THEME_STORAGE_VERSION &&
      parsed.version !== 2 &&
      parsed.version !== 1
    ) {
      return DEFAULT_THEME;
    }
    const family = normalizeThemeFamily(parsed.family);
    const mode = parsed.mode;
    if (!family || !isThemeMode(mode)) return DEFAULT_THEME;
    return { family, mode };
  } catch {
    return DEFAULT_THEME;
  }
}

function normalizeThemeFamily(value: unknown): ThemeFamily | null {
  switch (value) {
    case "playground":
      return "wordpress";
    case "wordpress":
    case "kandelo":
    case "ubuntu":
      return value;
    case "balanced":
    case "terminal":
      return "kandelo";
    default:
      return null;
  }
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "auto" || value === "light" || value === "dark";
}

function getSystemThemeMode(): ResolvedThemeMode {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
