/**
 * Reading what a Kandelo machine painted.
 *
 * A framebuffer demo has no text to assert on, so the evidence that it is
 * running is the canvas itself. Every spec that needs that evidence needs the
 * same reading, so it lives here rather than in each of them.
 */
import type { Locator } from "@playwright/test";

/** How many distinct colours a canvas is painting, capped so it stays cheap. */
export function distinctColors(canvas: Locator): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 8) break;
    }
    return seen.size;
  });
}
