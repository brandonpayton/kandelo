import { describe, expect, it, vi } from "vitest";
import { FramebufferRegistry } from "../../src/framebuffer/registry";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import { LocalFramebufferMirror } from "../../src/migration/mirror-local";
import { FakeDataChannel } from "../support/data-channel-pair";

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

  it("unbinds a watcher when the process gives /dev/fb0 up", async () => {
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const watcher = new LocalFramebufferMirror(channel);
    const source = publishedRegistry([1, 2, 3, 4, 5, 6, 7, 8]);
    const stopPublish = publisher.publish(source, 7);
    const sink = new FramebufferRegistry();
    const stopWatch = watcher.watch(sink);
    try {
      await vi.waitFor(() => expect(sink.get(7)).toBeDefined());
      source.unbind(7);
      await vi.waitFor(() => expect(sink.get(7)).toBeUndefined());
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("re-announces onto a watcher without rebinding it", async () => {
    // A congested publisher re-announces on every drain. Rebinding on each
    // one installs a fresh zeroed buffer and makes renderers re-attach onto
    // black, which is a blink for as long as the wire stays slow.
    const channel = `mirror-test-${crypto.randomUUID()}`;
    const publisher = new LocalFramebufferMirror(channel);
    const watcher = new LocalFramebufferMirror(channel);
    const source = publishedRegistry([1, 2, 3, 4, 5, 6, 7, 8]);
    const sink = new FramebufferRegistry();
    const changes: string[] = [];
    sink.onChange((pid, event) => changes.push(`${pid}:${event}`));
    const stopPublish = publisher.publish(source, 7);
    const stopWatch = watcher.watch(sink);
    try {
      await vi.waitFor(() => expect(sink.get(7)).toBeDefined());
      expect(changes).toEqual(["7:bind"]);

      // A second watcher's hello makes the publisher announce again, which
      // is the same message a drain resynchronisation sends.
      const rejoining = new LocalFramebufferMirror(channel);
      const sinkB = new FramebufferRegistry();
      const stopWatchB = rejoining.watch(sinkB);
      try {
        await vi.waitFor(() => expect(sinkB.get(7)).toBeDefined());
        expect(changes).toEqual(["7:bind"]);
        expect([...sink.get(7)!.hostBuffer!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      } finally {
        stopWatchB();
        rejoining.close();
      }
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

  it("ends the screen it was showing once the publisher stops", async () => {
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
        // And the watcher that was already there is told the screen ended,
        // rather than left holding the last frame as if it were live. The
        // publisher stops when the person holding the machine turns to its
        // terminal or gives the machine away, and pixels stopping cannot say
        // that on their own: a still screen sends no writes either.
        expect(sink.get(7)).toBeUndefined();
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

  it("skips writes on a congested channel and resynchronises on drain", async () => {
    const [publisherWire, watcherWire] = FakeDataChannel.pair({ auto: false });
    const publisherChannel = new ChunkedMessageChannel(publisherWire);
    const watcherChannel = new ChunkedMessageChannel(watcherWire);
    const publisher = new LocalFramebufferMirror(publisherChannel);
    const watcher = new LocalFramebufferMirror(watcherChannel);
    const source = publishedRegistry([1, 1, 1, 1, 1, 1, 1, 1]);
    const sink = new FramebufferRegistry();
    const receivedKinds: string[] = [];
    watcherChannel.addEventListener("message", (event) => {
      receivedKinds.push((event.data as { kind: string }).kind);
    });
    const stopPublish = publisher.publish(source, 7);
    const stopWatch = watcher.watch(sink);
    try {
      await vi.waitFor(() => {
        publisherWire.flush();
        expect([...sink.get(7)!.hostBuffer!]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      });

      publisherChannel.postMessage({
        kind: "stuffing",
        bytes: new Uint8Array(5 * 1024 * 1024),
      });
      expect(publisherChannel.congested()).toBe(true);
      source.fbWrite(7, 0, new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]));

      // The flushes free the wire; the drain re-announce carries the written
      // pixels as a fresh full frame, never as the skipped write.
      await vi.waitFor(() => {
        publisherWire.flush();
        expect([...sink.get(7)!.hostBuffer!]).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
      });
      expect(receivedKinds).not.toContain("write");
    } finally {
      stopPublish();
      stopWatch();
      publisherChannel.close();
      watcherChannel.close();
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
