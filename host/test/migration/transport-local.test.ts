import { describe, expect, it } from "vitest";
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
    filesystem: new Uint8Array([marker, marker]),
    monotonicNs: 5_000_000_000,
    framebuffers: [],
    kms: { fbs: [], crtcs: [], masterPid: null, buffers: [] },
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
      expect(taken.filesystem).toEqual(new Uint8Array([9, 9]));
      expect(taken.monotonicNs).toBe(5_000_000_000);
      expect(sent).toBe(1);
    } finally {
      stop();
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
