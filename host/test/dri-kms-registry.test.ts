import { describe, expect, it } from "vitest";
import { GbmBoRegistry } from "../src/dri/registry.js";
import { KmsRegistry } from "../src/dri/kms-registry.js";

function fb(id: number, bo_id = 100): {
  fb_id: number; bo_id: number; width: number; height: number;
  pixel_format: number; pitch: number;
} {
  return { fb_id: id, bo_id, width: 64, height: 32, pixel_format: 0x34325258, pitch: 256 };
}

describe("KmsRegistry", () => {
  it("addFb / rmFb / setFb / currentFb track bindings", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.currentFb(1)).toBeUndefined();

    kms.addFb(fb(10));
    kms.setFb(1, 10);
    expect(kms.currentFb(1)?.fb_id).toBe(10);

    kms.rmFb(10);
    expect(kms.currentFb(1)).toBeUndefined();
  });

  it("snapshot lists every modeset CRTC and survives rmFb", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.snapshot()).toEqual({ fbs: [], crtcs: [], masterPid: null });

    kms.addFb(fb(10));
    expect(kms.snapshot().crtcs).toEqual([]);

    kms.setFb(1, 10);
    kms.setFb(2, 10);
    kms.setMasterPid(7);
    expect(kms.snapshot().crtcs).toEqual([
      { crtc_id: 1, fb_id: 10 },
      { crtc_id: 2, fb_id: 10 },
    ]);
    expect(kms.snapshot().masterPid).toBe(7);

    // DRM leaves a CRTC modeset when its scanned-out framebuffer goes, so the
    // snapshot keeps naming an fb_id it no longer lists.
    kms.rmFb(10);
    expect(kms.currentFb(1)).toBeUndefined();
    expect(kms.snapshot().fbs).toEqual([]);
    expect(kms.snapshot().crtcs).toEqual([
      { crtc_id: 1, fb_id: 10 },
      { crtc_id: 2, fb_id: 10 },
    ]);
  });

  it("restore rebuilds a snapshotted display and replaces what it held", () => {
    const source = new KmsRegistry(new GbmBoRegistry());
    source.addFb(fb(10));
    source.setFb(1, 10);
    source.setMasterPid(7);

    const target = new KmsRegistry(new GbmBoRegistry());
    target.addFb(fb(99, 555));
    target.setFb(3, 99);
    target.restore(source.snapshot());

    expect(target.snapshot()).toEqual(source.snapshot());
    expect(target.currentFb(1)?.bo_id).toBe(100);
    expect(target.currentFb(3)).toBeUndefined();
    expect(target.isMasterPid(7)).toBe(true);
  });

  it("neither snapshot nor restore aliases a framebuffer record", () => {
    const source = new KmsRegistry(new GbmBoRegistry());
    source.addFb(fb(10));
    source.setFb(1, 10);
    const snapshot = source.snapshot();

    const target = new KmsRegistry(new GbmBoRegistry());
    target.restore(snapshot);
    snapshot.fbs[0]!.width = 1;

    expect(source.currentFb(1)?.width).toBe(64);
    expect(target.currentFb(1)?.width).toBe(64);
  });

  it("setMasterPid / dropMaster / isMasterPid", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    expect(kms.isMasterPid(7)).toBe(false);
    kms.setMasterPid(7);
    expect(kms.isMasterPid(7)).toBe(true);
    expect(kms.isMasterPid(8)).toBe(false);
    kms.dropMaster();
    expect(kms.isMasterPid(7)).toBe(false);
  });

  it("scanoutBytes returns the bo's pixel SAB for the bound CRTC", () => {
    const bos = new GbmBoRegistry();
    bos.create({ pid: 1, bo_id: 100, size: 4096, w: 32, h: 32, stride: 128 });
    const kms = new KmsRegistry(bos);

    expect(kms.scanoutBytes(1)).toBeUndefined();

    kms.addFb(fb(10, 100));
    kms.setFb(1, 10);
    const bytes = kms.scanoutBytes(1);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes!.byteLength).toBe(4096);
  });

  it("scanoutBytes returns undefined for an unknown bo", () => {
    const kms = new KmsRegistry(new GbmBoRegistry());
    kms.addFb(fb(10, 999));
    kms.setFb(1, 10);
    expect(kms.scanoutBytes(1)).toBeUndefined();
  });

  it("scanoutBytes syncs the writer's wasm Memory into the SAB on every call", () => {
    const mem = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
    const bos = new GbmBoRegistry({ getProcessMemory: (p) => p === 7 ? mem : undefined });
    bos.create({ pid: 7, bo_id: 100, size: 4096, w: 32, h: 32, stride: 128 });
    bos.bind(7, 100, 0, 4096);

    const kms = new KmsRegistry(bos);
    kms.addFb(fb(10, 100));
    kms.setFb(1, 10);

    new Uint8Array(mem.buffer, 0, 4096).fill(0xab);
    const view1 = kms.scanoutBytes(1)!;
    expect(view1[0]).toBe(0xab);

    new Uint8Array(mem.buffer, 0, 4096).fill(0xcd);
    const view2 = kms.scanoutBytes(1)!;
    expect(view2[0]).toBe(0xcd);
  });
});
