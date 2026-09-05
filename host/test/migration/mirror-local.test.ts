import { describe, expect, it, vi } from "vitest";
import { FramebufferRegistry } from "../../src/framebuffer/registry";
import { LocalFramebufferMirror } from "../../src/migration/mirror-local";

const WRITE_BASED = { pid: 7, addr: 0, len: 0, w: 2, h: 1, stride: 8, fmt: "BGRA32" as const };

function publishedRegistry(pixels: number[]): FramebufferRegistry {
  const registry = new FramebufferRegistry();
  registry.bind(WRITE_BASED);
  registry.fbWrite(7, 0, new Uint8Array(pixels));
  return registry;
}

describe("local framebuffer mirror", () => {
  it("seeds a late watcher with the binding and the current frame", async () => {
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const watcher = new LocalFramebufferMirror(channel);
    const source = publishedRegistry([1, 2, 3, 4, 5, 6, 7, 8]);
    const stopPublish = publisher.publish(source, 7);
    const sink = new FramebufferRegistry();
    const stopWatch = watcher.watch(sink);
    try {
      await vi.waitFor(() => {
        const binding = sink.get(7);
        expect(binding?.w).toBe(2);
        expect(binding?.h).toBe(1);
        expect([...binding!.hostBuffer!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      });
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("forwards each pixel write to a running watcher", async () => {
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const watcher = new LocalFramebufferMirror(channel);
    const source = publishedRegistry([0, 0, 0, 0, 0, 0, 0, 0]);
    const stopPublish = publisher.publish(source, 7);
    const sink = new FramebufferRegistry();
    const stopWatch = watcher.watch(sink);
    try {
      await vi.waitFor(() => expect(sink.get(7)).toBeDefined());
      source.fbWrite(7, 4, new Uint8Array([9, 9]));
      await vi.waitFor(() => {
        expect([...sink.get(7)!.hostBuffer!]).toEqual([0, 0, 0, 0, 9, 9, 0, 0]);
      });
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("announces a binding that appears after publishing started", async () => {
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const watcher = new LocalFramebufferMirror(channel);
    const source = new FramebufferRegistry();
    const stopPublish = publisher.publish(source, 7);
    const sink = new FramebufferRegistry();
    const stopWatch = watcher.watch(sink);
    try {
      source.bind(WRITE_BASED);
      source.fbWrite(7, 0, new Uint8Array([4, 3, 2, 1, 0, 0, 0, 0]));
      await vi.waitFor(() => {
        expect([...sink.get(7)!.hostBuffer!]).toEqual([4, 3, 2, 1, 0, 0, 0, 0]);
      });
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("stops forwarding once the publisher stops", async () => {
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const watcher = new LocalFramebufferMirror(channel);
    const source = publishedRegistry([1, 1, 1, 1, 1, 1, 1, 1]);
    const stopPublish = publisher.publish(source, 7);
    const sink = new FramebufferRegistry();
    const stopWatch = watcher.watch(sink);
    try {
      await vi.waitFor(() => expect(sink.get(7)).toBeDefined());
      stopPublish();
      source.fbWrite(7, 0, new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]));
      const watcherB = new LocalFramebufferMirror(channel);
      const sinkB = new FramebufferRegistry();
      const stopWatchB = watcherB.watch(sinkB);
      try {
        // The stopped publisher must answer neither the hello nor the write;
        // a second watcher joining now proves the silence isn't a race.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sinkB.get(7)).toBeUndefined();
        expect([...sink.get(7)!.hostBuffer!]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      } finally {
        stopWatchB();
        watcherB.close();
      }
    } finally {
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("refuses to mirror an mmap-based binding", () => {
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const source = new FramebufferRegistry();
    source.bind({ pid: 7, addr: 4096, len: 8, w: 2, h: 1, stride: 8, fmt: "BGRA32" });
    try {
      expect(() => publisher.publish(source, 7)).toThrow(
        "only a write-based framebuffer binding can be mirrored",
      );
    } finally {
      publisher.close();
    }
  });
});
