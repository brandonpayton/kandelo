import * as React from "react";
import { useWebPreview } from "../kernel-host/react";
import { Framebuffer, type FramebufferProps } from "./Framebuffer";
import { Modeset } from "./Modeset";
import type { PrimarySurface } from "../../../../../web-libs/kandelo-session/src/kernel-host";

export interface WordPressLoginOptions {
  username: string;
  password: string;
  loginPath?: string;
  adminPath?: string;
}

export interface DisplayHandle {
  loginToWordPress(options: WordPressLoginOptions): Promise<void>;
  reloadPreview(): void;
}

export interface DisplayProps extends FramebufferProps {
  /**
   * Which demo surface the parent decided to mount. The mount is one of
   * "framebuffer" | "web" | "kms" -- Display routes to the matching pane.
   * Defaults to legacy behavior (web if a preview exists, otherwise
   * framebuffer) for callers that don't yet pass a surface.
   */
  surface?: PrimarySurface;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
  /** Reports every page the preview lands on, for a publisher mirroring it. */
  onPreviewPathChange?: (path: string) => void;
  /**
   * The path the other computer's preview is on, for a viewer following it.
   * Undefined on a machine browsing for itself; null on a viewer the user
   * has not navigated for yet, which shows the preview's message instead of
   * loading a page the replayed exchanges may not hold.
   */
  previewViewerPath?: string | null;
}

export const Display = React.forwardRef<DisplayHandle, DisplayProps>(({ surface, onDockControlsChange, ...props }, ref) => {
  const preview = useWebPreview();

  if (surface === "kms") return <Modeset {...props} onDockControlsChange={onDockControlsChange} />;
  if (surface === "framebuffer") return <Framebuffer {...props} onDockControlsChange={onDockControlsChange} />;
  if (surface === "web" && preview) {
    return <WebPreviewPane ref={ref} preview={preview} onDockControlsChange={onDockControlsChange} {...props} />;
  }
  if (!preview) return <Framebuffer {...props} onDockControlsChange={onDockControlsChange} />;
  return <WebPreviewPane ref={ref} preview={preview} onDockControlsChange={onDockControlsChange} {...props} />;
});

Display.displayName = "Display";

const WebPreviewPane = React.forwardRef<DisplayHandle, FramebufferProps & {
  preview: NonNullable<ReturnType<typeof useWebPreview>>;
  onDockControlsChange?: (controls: React.ReactNode | null) => void;
  onPreviewPathChange?: (path: string) => void;
  previewViewerPath?: string | null;
}>(({ preview, autoFocus = false, onDockControlsChange, onPreviewPathChange, previewViewerPath }, ref) => {
  const [path, setPath] = React.useState("/");
  const [iframeSrc, setIframeSrc] = React.useState(() => buildPreviewUrl(preview.url, "/"));
  const ready = preview.status === "running"
    && (previewViewerPath === undefined || previewViewerPath !== null);
  const pendingRequests = preview.pendingRequests ?? 0;
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);

  React.useEffect(() => {
    setPath("/");
    setIframeSrc(buildPreviewUrl(preview.url, "/"));
  }, [preview.url]);

  React.useEffect(() => {
    if (!autoFocus || !ready) return;
    const handle = window.requestAnimationFrame(() => {
      iframeRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocus, iframeSrc, ready]);

  // Keep the iframe's browsing context alive. Internal navigations are synced
  // in onLoad, while parent-initiated navigations target the existing frame.
  const navigateFrame = React.useCallback((target: string) => {
    const frame = iframeRef.current;
    if (frame?.contentWindow) {
      try {
        frame.contentWindow.location.assign(target);
        return;
      } catch {
        // Fall back to updating src for unusual cross-origin or detached cases.
      }
    }
    setIframeSrc(target);
  }, []);

  const navigate = React.useCallback((raw: string) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
  }, [navigateFrame, preview.url]);

  const navigateAndWait = React.useCallback(async (
    raw: string,
    predicate: (document: Document) => boolean,
    timeoutMs = 120_000,
  ) => {
    const next = normalizePreviewPath(raw, preview.url);
    setPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
    await waitForFrameDocument(iframeRef, predicate, timeoutMs);
  }, [navigateFrame, preview.url]);

  const reloadPreview = React.useCallback(() => {
    const frame = iframeRef.current;
    if (frame?.contentWindow) {
      try {
        frame.contentWindow.location.reload();
        return;
      } catch {
        // Fall through to a best-effort navigation to the synced path.
      }
    }
    navigateFrame(buildPreviewUrl(preview.url, path));
  }, [navigateFrame, path, preview.url]);

  const syncFromFrame = React.useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    try {
      const href = frame.contentWindow?.location.href;
      if (!href) return;
      const next = relativePathFromHref(preview.url, href);
      if (!next) return;
      setPath(next);
      onPreviewPathChange?.(next);
    } catch {
      // Cross-origin navigations are not expected for the service bridge,
      // but ignore them so the preview itself keeps working.
    }
  }, [onPreviewPathChange, preview.url]);

  // A viewer's preview goes where the other computer's went, and nowhere on
  // its own: until the first mirrored path arrives, `ready` above keeps the
  // frame unmounted so it does not load a page the replayed exchanges may
  // not hold.
  React.useEffect(() => {
    if (previewViewerPath === undefined || previewViewerPath === null) return;
    const next = normalizePreviewPath(previewViewerPath, preview.url);
    setPath(next);
    navigateFrame(buildPreviewUrl(preview.url, next));
  }, [navigateFrame, preview.url, previewViewerPath]);

  const dockControls = React.useMemo(() => (
    <WebPreviewDockControls
      baseUrl={preview.url}
      path={path}
      ready={ready}
      pendingRequests={pendingRequests}
      message={preview.message}
      onNavigate={navigate}
      onReload={reloadPreview}
    />
  ), [navigate, path, pendingRequests, preview.message, preview.url, ready, reloadPreview]);

  React.useEffect(() => {
    if (!onDockControlsChange) return;
    onDockControlsChange(dockControls);
    return () => onDockControlsChange(null);
  }, [dockControls, onDockControlsChange]);

  React.useImperativeHandle(ref, () => ({
    reloadPreview,
    async loginToWordPress(options) {
      if (!ready) throw new Error("Web preview is not ready");
      const loginPath = options.loginPath ?? "/wp-login.php";
      const adminPath = options.adminPath ?? "/wp-admin/";

      await navigateAndWait(
        loginPath,
        (doc) => isWordPressLoginVisible(doc) || isWordPressAdminVisible(doc),
      );
      let doc = frameDocument(iframeRef);
      if (!doc) throw new Error("WordPress preview is unavailable");
      if (!isWordPressAdminVisible(doc)) {
        const userInput = doc.querySelector<HTMLInputElement>("#user_login");
        const passwordInput = doc.querySelector<HTMLInputElement>("#user_pass");
        const submit = doc.querySelector<HTMLElement>("#wp-submit");
        if (!userInput || !passwordInput || !submit) {
          throw new Error("WordPress login form is not available");
        }
        setInputValue(userInput, options.username);
        setInputValue(passwordInput, options.password);
        submit.click();
        await waitForFrameDocument(iframeRef, isWordPressAdminVisible);
      }

      doc = frameDocument(iframeRef);
      if (!doc || !isWordPressAdminVisible(doc)) {
        await navigateAndWait(adminPath, isWordPressAdminVisible);
      }
    },
  }), [navigateAndWait, ready, reloadPreview]);

  return (
    <div className="kdisplay-surface">
      {ready ? (
        <iframe
          ref={iframeRef}
          className="kweb-frame"
          src={iframeSrc}
          title={preview.label}
          onLoad={() => {
            syncFromFrame();
            if (autoFocus) iframeRef.current?.focus();
          }}
        />
      ) : (
        <div className={`kdisplay-status${preview.status === "error" ? " is-error" : ""}`} role="status">
          {preview.message ?? "Starting service"}
        </div>
      )}
    </div>
  );
});

WebPreviewPane.displayName = "WebPreviewPane";

const WebPreviewDockControls: React.FC<{
  baseUrl: string;
  path: string;
  ready: boolean;
  pendingRequests: number;
  message?: string;
  onNavigate: (path: string) => void;
  onReload: () => void;
}> = ({ baseUrl, path, ready, pendingRequests, message, onNavigate, onReload }) => {
  const [draftPath, setDraftPath] = React.useState(path);
  const loading = ready && pendingRequests > 0;
  const loadingTitle = loading
    ? `${pendingRequests} pending preview ${pendingRequests === 1 ? "request" : "requests"}`
    : undefined;

  React.useEffect(() => {
    setDraftPath(path);
  }, [path]);

  return (
    <form
      className="kweb-urlbar"
      title={ready ? undefined : message ?? "Starting service"}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onNavigate(draftPath);
      }}
    >
      <button
        type="button"
        className="kdock-view-iconbtn kweb-reload"
        onClick={onReload}
        disabled={!ready}
        title="Reload preview"
        aria-label="Reload preview"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M13 6.5A5 5 0 1 0 11.4 11" />
          <path d="M13 3.5v3h-3" />
        </svg>
      </button>
      <input
        className="kweb-urlbar-input"
        value={draftPath}
        onChange={(event) => setDraftPath(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (ready) onNavigate(event.currentTarget.value);
        }}
        onBlur={() => setDraftPath((value) => normalizePreviewPath(value, baseUrl))}
        disabled={!ready}
        spellCheck={false}
        enterKeyHint="go"
        aria-label="Preview URL path"
      />
      <span
        className={`kweb-loading${loading ? " is-active" : ""}`}
        role={loading ? "status" : undefined}
        aria-hidden={loading ? undefined : true}
        aria-label={loading ? "Loading preview" : undefined}
        title={loadingTitle}
      >
        <span className="kweb-loading-spinner" aria-hidden="true" />
        <span className="kweb-loading-text">Loading...</span>
      </span>
    </form>
  );
};

function buildPreviewUrl(base: string, path: string): string {
  if (base === "about:blank") return base;
  try {
    const root = new URL(base, window.location.href);
    const normalized = normalizePreviewPath(path, base);
    const rel = normalized.slice(1);
    return new URL(rel || ".", root).href;
  } catch {
    return base;
  }
}

function normalizePreviewPath(raw: string, base: string): string {
  const value = raw.trim();
  if (!value) return "/";

  const fromAbsolute = relativePathFromHref(base, value);
  if (fromAbsolute) return fromAbsolute;

  if (value.startsWith("?") || value.startsWith("#")) return `/${value}`;
  return value.startsWith("/") ? value : `/${value}`;
}

function relativePathFromHref(base: string, href: string): string | null {
  if (base === "about:blank") return "/";
  try {
    const root = new URL(base, window.location.href);
    const url = new URL(href, root);
    const rootPath = root.pathname.endsWith("/") ? root.pathname : `${root.pathname}/`;
    if (url.origin !== root.origin || !url.pathname.startsWith(rootPath)) return null;
    const suffix = url.pathname.slice(rootPath.length);
    return `/${suffix}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function frameDocument(ref: React.RefObject<HTMLIFrameElement>): Document | null {
  try {
    return ref.current?.contentDocument ?? ref.current?.contentWindow?.document ?? null;
  } catch {
    return null;
  }
}

async function waitForFrameDocument(
  ref: React.RefObject<HTMLIFrameElement>,
  predicate: (document: Document) => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const started = performance.now();
  let lastError = "";
  while (performance.now() - started < timeoutMs) {
    const doc = frameDocument(ref);
    if (doc) {
      try {
        if (predicate(doc)) return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    await sleep(100);
  }
  throw new Error(lastError || "Timed out waiting for the web preview");
}

function isWordPressLoginVisible(document: Document): boolean {
  return document.querySelector("#loginform #user_login") !== null &&
    document.querySelector("#loginform #user_pass") !== null;
}

function isWordPressAdminVisible(document: Document): boolean {
  return document.querySelector("#wpadminbar, #adminmenu") !== null ||
    document.body?.classList.contains("wp-admin") === true;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
