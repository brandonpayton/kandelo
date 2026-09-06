/**
 * Reading what a Kandelo machine painted.
 *
 * A framebuffer demo has no text to assert on, so the evidence that it is
 * running is the canvas itself. Every spec that needs that evidence needs the
 * same reading, so it lives here rather than in each of them.
 */
import type { Locator } from "@playwright/test";

/**
 * Mean brightness of one region of the canvas, 0..255.
 *
 * The region is given as fractions of the surface, so a spec asserts on
 * where paint landed without knowing the framebuffer's pixel size.
 */
export function regionBrightness(
  canvas: Locator,
  region: { x: number; y: number; w: number; h: number },
): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement, r) => {
    const scratch = document.createElement("canvas");
    scratch.width = el.width;
    scratch.height = el.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) return 0;
    ctx.drawImage(el, 0, 0);
    const x = Math.floor(r.x * scratch.width);
    const y = Math.floor(r.y * scratch.height);
    const w = Math.max(1, Math.floor(r.w * scratch.width));
    const h = Math.max(1, Math.floor(r.h * scratch.height));
    const { data } = ctx.getImageData(x, y, w, h);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
    }
    return sum / (data.length / 4);
  }, region);
}

/** How many distinct colours a canvas is painting, capped so it stays cheap. */
export function distinctColors(canvas: Locator): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    // A copy, not el.getContext: a kms canvas has transferred its control to
    // the kernel worker's OffscreenCanvas, and its own context is unreachable.
    const scratch = document.createElement("canvas");
    scratch.width = el.width;
    scratch.height = el.height;
    const ctx = scratch.getContext("2d");
    if (!ctx) return 0;
    ctx.drawImage(el, 0, 0);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 8) break;
    }
    return seen.size;
  });
}
