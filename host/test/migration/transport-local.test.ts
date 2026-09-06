import { describe, expect, it, vi } from "vitest";
import { ChunkedMessageChannel } from "../../src/migration/channel-chunked";
import {
  MACHINE_CHECKPOINT_FORMAT,
  type MachineCheckpoint,
} from "../../src/migration/checkpoint";
import { LocalCheckpointHandover } from "../../src/migration/transport-local";
import { FakeDataChannel } from "../support/data-channel-pair";

function fakeCheckpoint(marker: number): MachineCheckpoint {
  return {
    format: MACHINE_CHECKPOINT_FORMAT,
    kernelAbiVersion: 43,
    kernelMemory: new Uint8Array([marker]),
    filesystems: [
      { mountPoint: "/", bytes: new Uint8Array([marker, marker]) },
      { mountPoint: "/home/maker", bytes: new Uint8Array([marker]) },
    ],
    unreadableFilesystems: [],
    monotonicNs: 5_000_000_000,
    framebuffers: [],
    kms: { fbs: [], crtcs: [], masterPid: null, buffers: [] },
    gl: [],
    epolls: [],
    processes: [],
  };
}

describe("local checkpoint handover", () => {
  it("hands a checkpoint from an offering keeper to a taker", async () => {
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover(channel);
    const taker = new LocalCheckpointHandover(channel);
    let sent = 0;
    const stop = keeper.offer(
      () => Promise.resolve(fakeCheckpoint(7)),
      () => {
        sent++;
      },
    );
    try {
      const taken = await taker.take(5_000);
      expect(taken.kernelMemory).toEqual(new Uint8Array([7]));
      expect(taken.monotonicNs).toBe(5_000_000_000);
      expect(sent).toBe(1);
    } finally {
      stop();
      keeper.close();
      taker.close();
    }
  });

  it("surfaces a keeper's refusal instead of timing out", async () => {
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover(channel);
    const taker = new LocalCheckpointHandover(channel);
    const stop = keeper.offer(() => Promise.resolve(null));
    try {
      await expect(taker.take(5_000)).rejects.toThrow(
        "the keeper refused the handover: the keeper has no machine",
      );
    } finally {
      stop();
      keeper.close();
      taker.close();
    }
  });

  it("surfaces a capture failure as a refusal", async () => {
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover(channel);
    const taker = new LocalCheckpointHandover(channel);
    const stop = keeper.offer(() =>
      Promise.reject(new Error("freeze timed out"))
    );
    try {
      await expect(taker.take(5_000)).rejects.toThrow(
        "the keeper refused the handover: freeze timed out",
      );
    } finally {
      stop();
      keeper.close();
      taker.close();
    }
  });

  it("fails loudly when no keeper answers", async () => {
    const channel = `handover-test-${crypto.randomUUID()}`;
    const taker = new LocalCheckpointHandover(channel);
    try {
      await expect(taker.take(200)).rejects.toThrow(
        "no keeper answered the handover within 200 ms",
      );
    } finally {
      taker.close();
    }
  });

  it("hands a checkpoint across a chunked wire", async () => {
    const [keeperWire, takerWire] = FakeDataChannel.pair({ auto: true });
    const keeper = new LocalCheckpointHandover(
      new ChunkedMessageChannel(keeperWire),
    );
    const taker = new LocalCheckpointHandover(
      new ChunkedMessageChannel(takerWire),
    );
    let sent = 0;
    const stop = keeper.offer(
      () => Promise.resolve(fakeCheckpoint(9)),
      () => {
        sent++;
      },
    );
    try {
      const taken = await taker.take(5_000);
      expect(taken.kernelMemory).toEqual(new Uint8Array([9]));
      expect(taken.filesystems).toEqual([
        { mountPoint: "/", bytes: new Uint8Array([9, 9]) },
        { mountPoint: "/home/maker", bytes: new Uint8Array([9]) },
      ]);
      expect(taken.monotonicNs).toBe(5_000_000_000);
      expect(sent).toBe(1);
    } finally {
      stop();
      keeper.close();
      taker.close();
    }
  });

  it("tells a watcher which side holds the machine, in either direction", async () => {
    // Holding the machine is what decides who types, so the answer has to move
    // with the machine and keep moving: after a handover the keeper is the
    // viewer, and the computer that took it can be taken from in turn.
    const channel = `handover-test-${crypto.randomUUID()}`;
    const first = new LocalCheckpointHandover(channel);
    const second = new LocalCheckpointHandover(channel);
    const seenByFirst: boolean[] = [];
    const seenBySecond: boolean[] = [];
    const stopFirstWatch = first.watchKeeper((holding) =>
      seenByFirst.push(holding)
    );
    const stopSecondWatch = second.watchKeeper((holding) =>
      seenBySecond.push(holding)
    );
    try {
      // Nobody has said anything, so neither side offers a take.
      expect(seenByFirst).toEqual([]);
      expect(seenBySecond).toEqual([]);

      const stopFirstOffer = first.offer(() =>
        Promise.resolve(fakeCheckpoint(1))
      );
      await vi.waitFor(() => expect(seenBySecond.at(-1)).toBe(true));
      // A keeper does not report itself as its own peer's keeper.
      expect(seenByFirst).toEqual([]);

      // The machine moves. The old keeper withdraws and the new one announces,
      // so each side ends up seeing the opposite of what it saw before.
      stopFirstOffer();
      const stopSecondOffer = second.offer(() =>
        Promise.resolve(fakeCheckpoint(2))
      );
      await vi.waitFor(() => {
        expect(seenBySecond.at(-1)).toBe(false);
        expect(seenByFirst.at(-1)).toBe(true);
      });

      stopSecondOffer();
      await vi.waitFor(() => expect(seenByFirst.at(-1)).toBe(false));
    } finally {
      stopFirstWatch();
      stopSecondWatch();
      first.close();
      second.close();
    }
  });

  it("says what it is holding, so a watcher can load it in advance", async () => {
    // Taking a machine is mostly not moving it: a viewer holds no image of its
    // own, so the keeper's has to be loaded before the checkpoint has anywhere
    // to go. Naming the image early is what lets that happen before anyone
    // presses anything.
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover<MachineCheckpoint, string>(
      channel,
    );
    const taker = new LocalCheckpointHandover<MachineCheckpoint, string>(
      channel,
    );
    let running = "shell";
    const seen: Array<string | null> = [];
    const stopOffer = keeper.offer(
      () => Promise.resolve(fakeCheckpoint(4)),
      undefined,
      () => running,
    );
    const stopWatch = taker.watchKeeper((holding, offered) => {
      if (holding) seen.push(offered);
    });
    try {
      await vi.waitFor(() => expect(seen.at(-1)).toBe("shell"));

      // Read on every announcement, not once: a keeper that switches demos is
      // holding a different image, and a viewer that prewarmed the first would
      // have the wrong one ready.
      running = "doom";
      const stopSecondWatch = taker.watchKeeper(() => {});
      try {
        await vi.waitFor(() => expect(seen.at(-1)).toBe("doom"));
      } finally {
        stopSecondWatch();
      }
    } finally {
      stopWatch();
      stopOffer();
      keeper.close();
      taker.close();
    }
  });

  it("reports no description from a keeper that gives none", async () => {
    // Describing is optional, and a watcher must be able to tell "nothing was
    // said" from a description, rather than prewarming an undefined image.
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover<MachineCheckpoint, string>(
      channel,
    );
    const taker = new LocalCheckpointHandover<MachineCheckpoint, string>(
      channel,
    );
    const seen: Array<string | null> = [];
    const stopOffer = keeper.offer(() => Promise.resolve(fakeCheckpoint(5)));
    const stopWatch = taker.watchKeeper((holding, offered) => {
      if (holding) seen.push(offered);
    });
    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
      expect(seen.at(-1)).toBeNull();
    } finally {
      stopWatch();
      stopOffer();
      keeper.close();
      taker.close();
    }
  });

  it("answers a watcher that starts after the keeper", async () => {
    // The empty computer is usually the one that joins second, so a keeper
    // that only announced on start would leave it with no take-over button.
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover(channel);
    const taker = new LocalCheckpointHandover(channel);
    const stopOffer = keeper.offer(() => Promise.resolve(fakeCheckpoint(3)));
    const seen: boolean[] = [];
    const stopWatch = taker.watchKeeper((holding) => seen.push(holding));
    try {
      await vi.waitFor(() => expect(seen.at(-1)).toBe(true));
    } finally {
      stopWatch();
      stopOffer();
      keeper.close();
      taker.close();
    }
  });

  it("keeps concurrent takes separate", async () => {
    const channel = `handover-test-${crypto.randomUUID()}`;
    const keeper = new LocalCheckpointHandover(channel);
    const takerA = new LocalCheckpointHandover(channel);
    const takerB = new LocalCheckpointHandover(channel);
    let counter = 0;
    const stop = keeper.offer(() => Promise.resolve(fakeCheckpoint(++counter)));
    try {
      const [a, b] = await Promise.all([
        takerA.take(5_000),
        takerB.take(5_000),
      ]);
      expect([a.kernelMemory[0], b.kernelMemory[0]].sort()).toEqual([1, 2]);
    } finally {
      stop();
      keeper.close();
      takerA.close();
      takerB.close();
    }
  });
});
