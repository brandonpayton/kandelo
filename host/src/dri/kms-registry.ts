import type { GbmBoRegistry } from "./registry.js";

export type HostFb = {
  fb_id: number;
  bo_id: number;
  width: number;
  height: number;
  pixel_format: number;
  pitch: number;
};

/** One CRTC the guest drove `drmModeSetCrtc` on, and the framebuffer it scans
 *  out. */
export type KmsCrtcBinding = {
  readonly crtc_id: number;
  readonly fb_id: number;
};

/** Every DRM object this registry holds, without the pixels.
 *
 *  Pixels belong to the buffer objects the framebuffers name, so a caller that
 *  carries this also carries `GbmBoRegistry.snapshot`. */
export type KmsSnapshot = {
  readonly fbs: readonly HostFb[];
  readonly crtcs: readonly KmsCrtcBinding[];
  readonly masterPid: number | null;
};

export class KmsRegistry {
  private fbs = new Map<number, HostFb>();
  private crtcBindings = new Map<number, number>();
  private masterPid: number | null = null;

  constructor(private gbm: GbmBoRegistry) {}

  addFb(fb: HostFb): void { this.fbs.set(fb.fb_id, fb); }
  rmFb(fb_id: number): void { this.fbs.delete(fb_id); }
  setFb(crtc_id: number, fb_id: number): void { this.crtcBindings.set(crtc_id, fb_id); }

  currentFb(crtc_id: number): HostFb | undefined {
    const id = this.crtcBindings.get(crtc_id);
    return id === undefined ? undefined : this.fbs.get(id);
  }

  setMasterPid(pid: number): void { this.masterPid = pid; }
  dropMaster(): void { this.masterPid = null; }
  isMasterPid(pid: number): boolean { return this.masterPid === pid; }

  /** First CRTC with an FB bound for which `pid` holds DRM master.
   *  Null if `pid` is not master or no CRTC has an FB yet. The kernel
   *  currently advertises a single CRTC, so the iteration order doesn't
   *  matter; once multi-head lands the caller can iterate `crtcBindings`
   *  directly. */
  masterCrtcForPid(pid: number): number | null {
    if (this.masterPid !== pid) return null;
    for (const crtc_id of this.crtcBindings.keys()) {
      return crtc_id;
    }
    return null;
  }

  /** Every DRM object the guest has created, for a checkpoint to carry.
   *
   *  A CRTC binding outlives `rmFb` on its framebuffer, matching DRM, where
   *  removing a scanned-out framebuffer leaves the CRTC modeset. A snapshot
   *  can therefore name a framebuffer it does not list, and a restore must
   *  accept that rather than treat it as a broken record. */
  snapshot(): KmsSnapshot {
    return {
      fbs: [...this.fbs.values()].map((fb) => ({ ...fb })),
      crtcs: [...this.crtcBindings].map(([crtc_id, fb_id]) => ({ crtc_id, fb_id })),
      masterPid: this.masterPid,
    };
  }

  /** Adopt a snapshot, replacing whatever this registry holds.
   *
   *  A restore runs this on a registry a fresh machine has not touched yet. */
  restore(state: KmsSnapshot): void {
    this.fbs = new Map(state.fbs.map((fb) => [fb.fb_id, { ...fb }]));
    this.crtcBindings = new Map(
      state.crtcs.map(({ crtc_id, fb_id }) => [crtc_id, fb_id]),
    );
    this.masterPid = state.masterPid;
  }

  scanoutBytes(crtc_id: number): Uint8Array | undefined {
    const fb = this.currentFb(crtc_id);
    if (!fb) return undefined;
    this.gbm.syncFromMemory(fb.bo_id);
    return this.gbm.pixelView(fb.bo_id);
  }
}
