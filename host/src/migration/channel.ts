/**
 * The message-channel contract the migration transports speak over.
 *
 * `BroadcastChannel` satisfies it structurally, so the same-origin transports
 * keep their default; a network adapter satisfies it by implementing the four
 * members. A channel that can fall behind — a network channel has a send
 * buffer, a `BroadcastChannel` does not — additionally reports congestion, so
 * a publisher of droppable traffic can skip payloads and resynchronise on
 * drain instead of queueing without bound.
 */
export interface MessageChannelLike {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

export interface ChannelCongestion {
  congested(): boolean;
  /** Fires when a congested channel has flushed its queue. Returns a stop. */
  onDrain(listener: () => void): () => void;
}

export function channelCongestion(
  channel: MessageChannelLike,
): ChannelCongestion | null {
  if ("congested" in channel && "onDrain" in channel) {
    return channel as MessageChannelLike & ChannelCongestion;
  }
  return null;
}
