// Shared helpers for booting BrowserKernel machines that OWN their VFS
// (kernelOwnedFs), so the main thread never holds a live VFS SharedArrayBuffer.
//
// Why this exists: on WebKit, a SharedArrayBuffer the persistent main thread
// holds is reclaimed only by a GC cycle that reserved WASM/SAB memory rarely
// triggers — so main-thread-owned VFS buffers accumulate across boots until
// Safari OOMs. In kernel-owned mode the worker owns the live VFS and
// Worker.terminate() frees it deterministically. The only main-thread buffer
// left is the small, transient per-boot image-build FS; these helpers track it
// and nudge WebKit's collector to reclaim it between boots.
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { overlayEtcFromRootfs } from "@host/vfs/rootfs-overlay";
import { isWebKitLikeBrowser } from "./browser-engine";
import rootfsVfsUrl from "@rootfs-vfs?url";

export { overlayEtcFromRootfs };
export { isWebKitLikeBrowser, isWebKitLikeUserAgent } from "./browser-engine";

const WEBKIT_RECLAIM_TIMEOUT_MS = 1_500;
const WEBKIT_RECLAIM_STEP_MS = 150;
const WEBKIT_RECLAIM_PRESSURE_BYTES = 32 * 1024 * 1024;

let pendingImageBufferReclaims = 0;
const trackedImageBuffers = new WeakSet<object>();
const imageBufferRegistry =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<void>(() => {
        pendingImageBufferReclaims = Math.max(0, pendingImageBufferReclaims - 1);
      })
    : null;

/**
 * Track a transient image-build buffer so {@link settleWebKitReclaim} can wait
 * for its reclamation instead of guessing with a fixed delay. The registry
 * holds `buf` weakly, so tracking it does not keep it alive. Registration is
 * idempotent because callers may track at allocation and again at finalization.
 */
export function trackTransientImageBuffer(buf: ArrayBufferLike): void {
  if (!imageBufferRegistry) return;
  const identity = buf as object;
  if (trackedImageBuffers.has(identity)) return;
  trackedImageBuffers.add(identity);
  pendingImageBufferReclaims += 1;
  imageBufferRegistry.register(identity, undefined);
}

/**
 * On WebKit, nudge the garbage collector until the transient image-build
 * buffers are reclaimed (or a short deadline elapses). Reserved/dropped
 * SharedArrayBuffers create little JS-heap pressure, so a bare timer does not
 * trigger collection — allocate+drop a pressure block and yield across frames.
 * No-op on engines that reclaim dropped buffers on their own (Chrome/Firefox).
 * Call after `kernel.destroy()` in per-boot loops and image switches.
 */
export async function settleWebKitReclaim(): Promise<void> {
  if (!isWebKitLikeBrowser()) return;
  const deadline = performance.now() + WEBKIT_RECLAIM_TIMEOUT_MS;
  do {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    let pressure: ArrayBuffer | null = new ArrayBuffer(WEBKIT_RECLAIM_PRESSURE_BYTES);
    pressure = null;
    void pressure;
    await new Promise<void>((resolve) => window.setTimeout(resolve, WEBKIT_RECLAIM_STEP_MS));
  } while (
    imageBufferRegistry !== null &&
    pendingImageBufferReclaims > 0 &&
    performance.now() < deadline
  );
}

/**
 * Serialize an assembled build-time filesystem to transferable image bytes and
 * register its SharedArrayBuffer for reclamation tracking. Let the caller drop
 * its `buildFs` reference right after; the kernel worker rebuilds and owns the
 * live VFS from these bytes.
 */
export async function finalizeKernelOwnedImage(buildFs: MemoryFileSystem): Promise<Uint8Array> {
  const bytes = await buildFs.saveImage();
  trackTransientImageBuffer(buildFs.sharedBuffer);
  return bytes;
}

/** Create a fresh, empty build-time MemoryFileSystem for assembling an image
 *  that the kernel worker will own. Scratch mounts (/tmp, /var, /home/maker, …)
 *  are provided worker-side, so only the image's `/` content (e.g. /etc, /bin)
 *  needs to live here. */
export function createEmptyBuildFs(maxByteLength = 64 * 1024 * 1024): MemoryFileSystem {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  const initial = Math.min(16 * 1024 * 1024, maxByteLength);
  const sab = new SharedArrayBufferCtor(initial, { maxByteLength });
  return MemoryFileSystem.create(sab, maxByteLength);
}

/**
 * Convenience: an empty build FS pre-seeded with `/etc` from the canonical
 * rootfs — the kernel-owned equivalent of the legacy empty-FS + init()-overlay
 * starting point.
 */
export async function createBuildFsWithEtc(maxByteLength = 64 * 1024 * 1024): Promise<MemoryFileSystem> {
  const buildFs = createEmptyBuildFs(maxByteLength);
  await overlayEtcFromRootfs(buildFs, await fetchRootfsBytes());
  return buildFs;
}

let rootfsBytesPromise: Promise<Uint8Array> | null = null;

/**
 * Fetch the canonical rootfs image bytes (cached). Demos that previously
 * started from an empty FS and relied on the legacy `kernel.init()` overlay of
 * `/etc/{passwd,group,hosts,services}` from rootfs.vfs should seed their
 * build-time FS through `overlayEtcFromRootfs`, which authenticates imported
 * atomic seals before reading the source image.
 */
export function fetchRootfsBytes(): Promise<Uint8Array> {
  if (!rootfsBytesPromise) {
    rootfsBytesPromise = fetch(rootfsVfsUrl as string)
      .then((r) => {
        if (!r.ok) throw new Error(`rootfs.vfs fetch failed: ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => new Uint8Array(b))
      .catch((err) => {
        rootfsBytesPromise = null;
        throw err;
      });
  }
  return rootfsBytesPromise;
}
