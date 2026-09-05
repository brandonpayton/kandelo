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
  typed: () => string;
} {
  const listeners = new Set<(bytes: Uint8Array) => void>();
  const chunks: Uint8Array[] = [];
  return {
    source: {
      onOutput(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      write(bytes) {
        chunks.push(bytes.slice());
      },
      size: () => size,
    },
    emit(text) {
      const bytes = new TextEncoder().encode(text);
      for (const listener of [...listeners]) listener(bytes);
    },
    typed() {
      return chunks.map((each) => new TextDecoder().decode(each)).join("");
    },
  };
}

function fakeSink(): {
  sink: TerminalSink;
  text: (id: string) => string | undefined;
  size: (id: string) => TerminalSize | undefined;
  resets: () => number;
} {
  const screens = new Map<string, string>();
  const sizes = new Map<string, TerminalSize>();
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
    },
    text: (id) => screens.get(id),
    size: (id) => sizes.get(id),
    resets: () => resets,
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

  it("writes a watcher's keystrokes into the terminal", async () => {
    const channel = `terminal-test-${crypto.randomUUID()}`;
    const publisher = new LocalTerminalMirror(channel);
    const watcher = new LocalTerminalMirror(channel);
    const terminal = fakeTerminal();
    const stopPublish = publisher.publish(PTY, terminal.source);
    const sink = fakeSink();
    const stopWatch = watcher.watch(sink.sink);
    try {
      watcher.send(PTY, new TextEncoder().encode("ls\n"));
      await vi.waitFor(() => expect(terminal.typed()).toBe("ls\n"));

      // A watcher must not be able to type into a terminal nobody published
      // under that name.
      watcher.send("/dev/pts/9", new TextEncoder().encode("rm\n"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(terminal.typed()).toBe("ls\n");
    } finally {
      stopPublish();
      stopWatch();
      publisher.close();
      watcher.close();
    }
  });

  it("keeps two published terminals apart", async () => {
    // A machine offers every terminal it has, so one channel carries several.
    // Output must reach the screen it came from, and a keystroke must reach
    // the shell it was aimed at.
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

      watcher.send("/dev/pts/1", new TextEncoder().encode("ls\n"));
      await vi.waitFor(() => expect(second.typed()).toBe("ls\n"));
      expect(first.typed()).toBe("");
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
