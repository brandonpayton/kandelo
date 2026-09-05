/**
 * A manually signalled WebRTC link carrying the migration transports.
 *
 * WebRTC needs a third party to carry the offer, the answer, and the ICE
 * candidates before any peer-to-peer channel exists; this module makes the
 * humans that third party. One side creates an invite code, the other
 * answers it, and each code is the peer's session description with the
 * candidates gathered so far: local descriptions are read after ICE
 * gathering completes or after a bounded wait, whichever comes first, so a
 * network that silently drops STUN packets delays a code instead of hanging
 * its creation forever. A signalling server later replaces the copy-paste
 * with an automatic exchange of the same two strings; nothing else here
 * changes.
 *
 * The link opens four labeled, ordered, reliable data channels — one for the
 * checkpoint handover protocol, one for the framebuffer mirror, one for the
 * terminal mirror, one for the replication decision log — and wraps each in a
 * `ChunkedMessageChannel`, so the transports speak to a remote computer
 * exactly as they speak to a same-origin tab. Each label equals the
 * BroadcastChannel name its transport uses on one origin.
 *
 * STUN only: with no TURN relay configured, two peers whose NATs refuse a
 * direct route cannot connect, and the failure is reported as that boundary
 * rather than retried into silence.
 */
import { ChunkedMessageChannel } from "@host/migration/channel-chunked";

const HANDOVER_LABEL = "kandelo-checkpoint-handover";
const MIRROR_LABEL = "kandelo-framebuffer-mirror";
const TERMINAL_LABEL = "kandelo-terminal-mirror";
const REPLICATION_LABEL = "kandelo-replication-log";
const CODE_PREFIX = "kandelo1:";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];
const GATHERING_WAIT_MS = 3000;
/**
 * How much mirrored pixel traffic may wait in the wire's send buffer.
 *
 * Every queued byte is delay the watching computer sees, and a mirror frame
 * is droppable: the publisher would rather skip to the current frame than
 * deliver an old one. The handover keeps the deep default instead, because a
 * checkpoint is one message that wants the wire kept busy end to end. So does
 * the replication log: a skipped decision is a replica that stopped being the
 * same machine, so that traffic may be delayed but never dropped.
 */
const MIRROR_HIGH_WATER_BYTES = 128 * 1024;
const MIRROR_LOW_WATER_BYTES = 32 * 1024;

export interface PeerLink {
  readonly handover: ChunkedMessageChannel;
  readonly mirror: ChunkedMessageChannel;
  readonly terminal: ChunkedMessageChannel;
  readonly replication: ChunkedMessageChannel;
  onClose(listener: () => void): () => void;
  close(): void;
}

export interface PeerInvite {
  readonly invite: string;
  acceptAnswer(answer: string): Promise<PeerLink>;
  cancel(): void;
}

function encodeSignal(description: RTCSessionDescription): string {
  return (
    CODE_PREFIX
    + btoa(JSON.stringify({ type: description.type, sdp: description.sdp }))
  );
}

function decodeSignal(code: string): RTCSessionDescriptionInit {
  const trimmed = code.trim();
  if (!trimmed.startsWith(CODE_PREFIX)) {
    throw new Error("this is not a Kandelo connect code");
  }
  return JSON.parse(
    atob(trimmed.slice(CODE_PREFIX.length)),
  ) as RTCSessionDescriptionInit;
}

function gatheringSettled(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => {
      if (connection.iceGatheringState !== "complete") return;
      settle();
    };
    const timer = setTimeout(settle, GATHERING_WAIT_MS);
    connection.addEventListener("icegatheringstatechange", check);
  });
}

function channelOpen(
  connection: RTCPeerConnection,
  channel: RTCDataChannel,
): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const settle = (settled: () => void) => {
      channel.removeEventListener("open", onOpen);
      connection.removeEventListener("connectionstatechange", onState);
      settled();
    };
    const onOpen = () => settle(resolve);
    const onState = () => {
      if (connection.connectionState !== "failed") return;
      settle(() =>
        reject(
          new Error(
            "the peer connection failed — no direct route between the "
            + "peers, and no TURN relay is configured",
          ),
        ),
      );
    };
    channel.addEventListener("open", onOpen);
    connection.addEventListener("connectionstatechange", onState);
  });
}

function buildLink(
  connection: RTCPeerConnection,
  handoverChannel: RTCDataChannel,
  mirrorChannel: RTCDataChannel,
  terminalChannel: RTCDataChannel,
  replicationChannel: RTCDataChannel,
): PeerLink {
  const closeListeners = new Set<() => void>();
  let closed = false;
  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const listener of [...closeListeners]) listener();
  };
  handoverChannel.addEventListener("close", fireClose);
  connection.addEventListener("connectionstatechange", () => {
    if (
      connection.connectionState === "failed"
      || connection.connectionState === "closed"
    ) {
      fireClose();
    }
  });
  const handover = new ChunkedMessageChannel(handoverChannel);
  const mirror = new ChunkedMessageChannel(mirrorChannel, {
    highWaterBytes: MIRROR_HIGH_WATER_BYTES,
    lowWaterBytes: MIRROR_LOW_WATER_BYTES,
  });
  const terminal = new ChunkedMessageChannel(terminalChannel);
  const replication = new ChunkedMessageChannel(replicationChannel);
  return {
    handover,
    mirror,
    terminal,
    replication,
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: () => {
      handover.close();
      mirror.close();
      terminal.close();
      replication.close();
      connection.close();
      fireClose();
    },
  };
}

export async function createPeerInvite(): Promise<PeerInvite> {
  const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const handoverChannel = connection.createDataChannel(HANDOVER_LABEL);
  const mirrorChannel = connection.createDataChannel(MIRROR_LABEL);
  const terminalChannel = connection.createDataChannel(TERMINAL_LABEL);
  const replicationChannel = connection.createDataChannel(REPLICATION_LABEL);
  await connection.setLocalDescription(await connection.createOffer());
  await gatheringSettled(connection);
  return {
    invite: encodeSignal(connection.localDescription!),
    acceptAnswer: async (answer) => {
      await connection.setRemoteDescription(decodeSignal(answer));
      await Promise.all([
        channelOpen(connection, handoverChannel),
        channelOpen(connection, mirrorChannel),
        channelOpen(connection, terminalChannel),
        channelOpen(connection, replicationChannel),
      ]);
      return buildLink(
        connection,
        handoverChannel,
        mirrorChannel,
        terminalChannel,
        replicationChannel,
      );
    },
    cancel: () => connection.close(),
  };
}

export async function answerPeerInvite(
  invite: string,
): Promise<{ answer: string; connected: Promise<PeerLink> }> {
  const connection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channels = new Map<string, RTCDataChannel>();
  const channelArrivals = new Map<string, (channel: RTCDataChannel) => void>();
  const arrived = (label: string): Promise<RTCDataChannel> => {
    const channel = channels.get(label);
    if (channel) return Promise.resolve(channel);
    return new Promise((resolve) => channelArrivals.set(label, resolve));
  };
  connection.addEventListener("datachannel", (event) => {
    channels.set(event.channel.label, event.channel);
    channelArrivals.get(event.channel.label)?.(event.channel);
  });
  await connection.setRemoteDescription(decodeSignal(invite));
  await connection.setLocalDescription(await connection.createAnswer());
  await gatheringSettled(connection);
  const connected = (async () => {
    const [handoverChannel, mirrorChannel, terminalChannel, replicationChannel] =
      await Promise.all([
        arrived(HANDOVER_LABEL),
        arrived(MIRROR_LABEL),
        arrived(TERMINAL_LABEL),
        arrived(REPLICATION_LABEL),
      ]);
    await Promise.all([
      channelOpen(connection, handoverChannel),
      channelOpen(connection, mirrorChannel),
      channelOpen(connection, terminalChannel),
      channelOpen(connection, replicationChannel),
    ]);
    return buildLink(
      connection,
      handoverChannel,
      mirrorChannel,
      terminalChannel,
      replicationChannel,
    );
  })();
  return { answer: encodeSignal(connection.localDescription!), connected };
}
