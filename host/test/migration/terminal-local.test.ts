import { describe, expect, it, vi } from "vitest";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import {
  LocalTerminalMirror,
  type TerminalSink,
  type TerminalSize,
  type TerminalSource,
} from "../../src/migration/terminal-local";
import { FakeDataChannel } from "../support/data-channel-pair";

const PTY = "/dev/pts/0";

function fakeTerminal(size: TerminalSize = { cols: 80, rows: 24 }): {
  source: TerminalSource;
  emit: (text: string) => void;
} {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  return {
    source: {
      onOutput(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      size: () => size,
    },
    emit(text) {
      const bytes = new TextEncoder().encode(text);
      for (const listener of [...listeners]) listener(bytes);
    },
  };
}

function fakeSink(): {
  sink: TerminalSink;
  text: (id: string) => string | undefined;
  size: (id: string) => TerminalSize | undefined;
  resets: () => number;
  ended: () => string[];
} {
  const screens = new Map<string, string>();
  const sizes = new Map<string, TerminalSize>();
  const ended: string[] = [];
  let resets = 0;
  return {
    sink: {
      reset(id, size, bytes) {
        resets += 1;
        sizes.set(id, size);
        screens.set(id, new TextDecoder().decode(bytes));
      },
      output(id, bytes) {
        screens.set(id, (screens.get(id) ?? "") + new TextDecoder().decode(bytes));
      },
      ended(id) {
        ended.push(id);
      },
    },
    text: (id) => screens.get(id),
    size: (id) => sizes.get(id),
    resets: () => resets,
    ended: () => ended,
  };
}

describe("local terminal mirror", () => {
  it("seeds a late watcher with the current screen and its size", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal({ cols: 100, rows: 30 });
    const stopPublish = publisher.publish(PTY, terminal.source);
    terminal.emit("kandelo:~$ ");
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      await vi.waitFor(() => expect(sink.text(PTY)).toBe("kandelo:~$ "));
      expect(sink.size(PTY)).toEqual({ cols: 100, rows: 30 });
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("forwards output to a running watcher", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal();
    const stopPublish = publisher.publish(PTY, terminal.source);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      await vi.waitFor(() => expect(sink.text(PTY)).toBe(""));
      terminal.emit("hello");
      terminal.emit(" world");
      await vi.waitFor(() => expect(sink.text(PTY)).toBe("hello world"));
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("tells a watcher the terminal ended when the publisher stops", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal();
    const stopPublish = publisher.publish(PTY, terminal.source);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      await vi.waitFor(() => expect(sink.text(PTY)).toBe(""));
      expect(sink.ended()).toEqual([]);
      // The person holding the machine turned to its screen. Output simply
      // stopping cannot say that — a terminal nobody is typing into is silent
      // too — so a watcher told nothing keeps a dead screen up beside the
      // surface that replaced it.
      stopPublish();
      await vi.waitFor(() => expect(sink.ended()).toEqual([PTY]));
    } finally {
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("gives a watcher that joins mid-stream each byte exactly once", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal();
    const stopPublish = publisher.publish(PTY, terminal.source);
    terminal.emit("kandelo$ ");
    const sink = fakeSink();
    // The seeding reset and this output cross on the wire: the machine keeps
    // printing while the watcher's hello is still travelling. Output the seed
    // already carries must not land on screen a second time.
    const stopWatch = watcher.watch(sink.sink);
    terminal.emit("echo hi\r\n");
    try {
      await vi.waitFor(() =>
        expect(sink.text(PTY)).toBe("kandelo$ echo hi\r\n"),
      );
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("does not double a terminal that is published again", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal();
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    // A dropped link republishes the same PTY. The watcher renders one
    // machine, so it must see one copy of what that machine printed.
    publisher.publish(PTY, terminal.source)();
    const stopPublish = publisher.publish(PTY, terminal.source);
    terminal.emit("kandelo$ ");
    try {
      await vi.waitFor(() => expect(sink.text(PTY)).toBe("kandelo$ "));
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("keeps two published terminals apart", async () => {
    // A machine offers every terminal it has, so one channel carries several.
    // Output must reach the screen it came from.
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const first = fakeTerminal();
    const second = fakeTerminal();
    const stopFirst = publisher.publish("/dev/pts/0", first.source);
    const stopSecond = publisher.publish("/dev/pts/1", second.source);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      first.emit("one");
      second.emit("two");
      await vi.waitFor(() => {
        expect(sink.text("/dev/pts/0")).toBe("one");
        expect(sink.text("/dev/pts/1")).toBe("two");
      });
    } finally {
      stopFirst();
      stopSecond();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });


  it("replays the tail of a long stream, not all of it", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal();
    const stopPublish = publisher.publish(PTY, terminal.source);
    try {
      terminal.emit("x".repeat(200 * 1024));
      terminal.emit("END");
      const sink = fakeSink();
      const stopWatch = watcher.watch(sink.sink);
      try {
        await vi.waitFor(() => expect(sink.text(PTY)?.length).toBeGreaterThan(0));
        const screen = sink.text(PTY)!;
        expect(screen.length).toBe(128 * 1024);
        expect(screen.endsWith("END")).toBe(true);
      } finally {
        stopWatch();
      }
    } finally {
      stopPublish();
      publisher.close();
      watcher.close();
    }
  });

  it("skips output on a congested channel and resets on drain", async () => {
    const [publisherWire, watcherWire] = FakeDataChannel.pair({ auto: false });
    const publisherChannel = new ChunkedMessageChannel(publisherWire);
    const watcherChannel = new ChunkedMessageChannel(watcherWire);
    const publisher = new LocalTerminalMirror(publisherChannel);
    const watcher = new LocalTerminalMirror(watcherChannel);
    const terminal = fakeTerminal();
    const sink = fakeSink();
    const stopPublish = publisher.publish(PTY, terminal.source);
    const stopWatch = watcher.watch(sink.sink);
    try {
      terminal.emit("first ");
      await vi.waitFor(() => {
        publisherWire.flush();
        expect(sink.text(PTY)).toBe("first ");
      });

      publisherChannel.postMessage({
        kind: "stuffing",
        bytes: new Uint8Array(5 * 1024 * 1024),
      });
      expect(publisherChannel.congested()).toBe(true);
      terminal.emit("second ");

      // The skipped output is not lost to the screen: the drain reset carries
      // it as part of the replayed tail.
      await vi.waitFor(() => {
        publisherWire.flush();
        expect(sink.text(PTY)).toBe("first second ");
      });
      expect(sink.resets()).toBeGreaterThan(1);
    } finally {
      stopPublish();
      stopWatch();
      publisherChannel.close();
      watcherChannel.close();
    }
  });
});
