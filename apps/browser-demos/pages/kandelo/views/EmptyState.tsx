// First-run / empty state. Rendered when host.getStatus() === 'idle' and
// view === 'machine'.
//
// Three doors: pick a preset, paste a Kandelo URL, upload a VFS image.
// Featured presets row pulls from the same host.galleryQuery('presets')
// the Gallery uses, so adding a preset there shows up here for free.

import * as React from "react";
import markUrl from "../assets/kandelo-mark.png";
import { useGalleryItems } from "../kernel-host/react";
import { decodeBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type {
  BootDescriptor, GalleryItem,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";

type Door = "preset" | "paste" | "upload" | null;

export interface EmptyStateProps {
  onLaunchItem: (item: GalleryItem) => void;
  onBrowseAll: () => void;
  /** Called once the user pastes a Kandelo URL and confirms boot. */
  onApplyDescriptor: (desc: BootDescriptor) => void;
  /**
   * One line about a connected computer, shown under the tagline.
   *
   * A page with a peer but nothing to watch is still this page, so the state
   * of the link belongs here rather than in a surface that has nothing to
   * show. Null when no computer is connected.
   */
  peerNote?: string | null;
  /**
   * Whether this computer is watching the other computer's machine.
   *
   * A watcher holds no machine of its own and is not meant to start one: the
   * machine reaches it by handover, not by boot. False on a page with no peer.
   */
  watching?: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  onLaunchItem, onBrowseAll, onApplyDescriptor, peerNote = null,
  watching = false,
}) => {
  const [door, setDoor] = React.useState<Door>(null);
  const [pasteUrl, setPasteUrl] = React.useState("");
  const [pasteError, setPasteError] = React.useState<string | null>(null);
  const { items: presets } = useGalleryItems("presets");

  const featured = presets.slice(0, 6);

  const tryPaste = async () => {
    if (!pasteUrl) return;
    setPasteError(null);
    const hashIdx = pasteUrl.indexOf("#");
    const fragment = hashIdx === -1 ? "" : pasteUrl.slice(hashIdx + 1);
    if (!fragment) {
      setPasteError("URL has no #k1=… fragment. Paste a full Kandelo link.");
      return;
    }
    try {
      const desc = await decodeBootDescriptor(fragment);
      if (!desc) {
        setPasteError("Fragment is not a `k1=` envelope.");
        return;
      }
      onApplyDescriptor(desc);
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    }
  };

  const hero = (
    <div className="kempty-hero">
      <img className="kempty-logo" src={markUrl} alt="" />
      <h1 className="kempty-wordmark">Kandelo</h1>
      <div className="kempty-tag">Boot a VFS image in your browser.</div>
      {peerNote && (
        <div className="kempty-peer-note" role="status">{peerNote}</div>
      )}
    </div>
  );

  // A watcher gets a waiting room, not a launcher. Booting here would start a
  // second machine unrelated to the one being watched, and stop the watching
  // to show it. The machine crosses by Take over this machine, in the Network
  // popup, so the ways to start one are not offered while a peer holds one.
  if (watching) {
    return (
      <div className="kempty">
        <div className="kempty-inner">{hero}</div>
      </div>
    );
  }

  return (
    <div className="kempty">
      <div className="kempty-inner">
        {hero}

        <div className="kempty-doors">
          <button
            className="kempty-door"
            data-active={door === "preset" ? "true" : undefined}
            onClick={() => setDoor((d) => (d === "preset" ? null : "preset"))}
          >
            <div className="kempty-door-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="2" y="3" width="6" height="6" rx="1" />
                <rect x="10" y="3" width="6" height="6" rx="1" />
                <rect x="2" y="11" width="6" height="6" rx="1" />
                <rect x="10" y="11" width="6" height="6" rx="1" />
              </svg>
            </div>
            <div className="kempty-door-title">Boot a preset VFS image</div>
            <div className="kempty-door-sub">
              Start a ready-made shell, server stack, or graphical demo.
            </div>
          </button>

          <button
            className="kempty-door"
            data-active={door === "paste" ? "true" : undefined}
            onClick={() => setDoor((d) => (d === "paste" ? null : "paste"))}
          >
            <div className="kempty-door-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 11l3-3M5 6h3M5 9l-2 2 2 2M10 12h3M13 9l2 2-2 2" />
              </svg>
            </div>
            <div className="kempty-door-title">Paste a Kandelo URL</div>
            <div className="kempty-door-sub">
              A link from chat or docs — Kandelo will show you what's inside before boot.
            </div>
          </button>

          <button
            className="kempty-door"
            data-active={door === "upload" ? "true" : undefined}
            onClick={() => setDoor((d) => (d === "upload" ? null : "upload"))}
          >
            <div className="kempty-door-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 3v8M6 6l3-3 3 3M3 14h12M3 14v2h12v-2" />
              </svg>
            </div>
            <div className="kempty-door-title">Bring your own VFS image</div>
            <div className="kempty-door-sub">
              Drop a .vfs.zst or signed manifest. Kandelo boots it in a sandbox.
            </div>
          </button>
        </div>

        {door === "paste" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="kempty-input"
                placeholder="https://kandelo.dev/c/wordpress#k1=…"
                value={pasteUrl}
                onChange={(e) => setPasteUrl(e.target.value)}
                style={{ flex: 1 }}
                autoFocus
              />
              <button className="kempty-btn" onClick={tryPaste}>
                Inspect &amp; boot
              </button>
            </div>
            {pasteError && (
              <div style={{ color: "var(--k-err)", fontSize: 11.5, fontFamily: "var(--k-font-mono)" }}>
                {pasteError}
              </div>
            )}
          </div>
        )}

        {door === "upload" && (
          <div style={{
            padding: "24px 20px",
            border: "1px dashed var(--k-border-strong)",
            borderRadius: "var(--k-radius)",
            textAlign: "center",
            background: "var(--k-surface-sunk)",
          }}>
            <div style={{ fontSize: 13, color: "var(--k-text)", fontWeight: 600 }}>
              Drop a .vfs.zst file here
            </div>
            <div style={{ fontSize: 11.5, color: "var(--k-text-muted)", marginTop: 4 }}>
              or click to choose · max 256 MiB · signature optional
            </div>
          </div>
        )}

        <div className="kempty-featured">
          <div className="kempty-featured-row">
            <div className="kempty-featured-lbl">Featured presets</div>
          </div>
          <div className="kempty-presets">
            {featured.map((p) => (
              <button
                key={p.id}
                className="kempty-preset"
                onClick={() => onLaunchItem(p)}
              >
                <div className="kempty-preset-glyph" style={{ background: p.accent }}>
                  {p.glyph}
                </div>
                <div className="kempty-preset-name">{p.title}</div>
                <div className="kempty-preset-sub">{p.summary}</div>
              </button>
            ))}
          </div>
          <button
            onClick={onBrowseAll}
            style={{
              alignSelf: "center",
              marginTop: 4,
              padding: "6px 12px",
              border: 0,
              background: "transparent",
              color: "var(--k-accent)",
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Browse all presets →
          </button>
        </div>
      </div>
    </div>
  );
};
