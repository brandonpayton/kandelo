// Peer session — the manually signalled link between two Kandelo machines.
//
// WHY: the connection outlives the popover that creates it. Holding the link,
// the codes and the status here means closing the Network popover does not
// drop a connection, and reopening it shows what is actually going on.
//
// The three steps are the ones the humans carry: one side creates an invite
// code, the other answers it, the first completes. A signalling server would
// replace the copy-paste with the same two strings and nothing else changes.
import * as React from "react";
import {
  answerPeerInvite,
  createPeerInvite,
  type PeerInvite,
  type PeerLink,
} from "../../../lib/peer-link";

export interface PeerSession {
  /** The code to hand to the other computer. */
  localCode: string;
  /** The code pasted from the other computer. */
  remoteCode: string;
  status: string;
  link: PeerLink | null;
  setRemoteCode: (code: string) => void;
  createInvite: () => void;
  answerInvite: () => void;
  completeConnection: () => void;
  disconnect: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePeerSession(): PeerSession {
  const [localCode, setLocalCode] = React.useState("");
  const [remoteCode, setRemoteCode] = React.useState("");
  const [status, setStatus] = React.useState("Not connected.");
  const [link, setLink] = React.useState<PeerLink | null>(null);
  const pendingInviteRef = React.useRef<PeerInvite | null>(null);
  // Every attempt supersedes the one before it. Without this, a superseded
  // attempt's late failure — or worse, its late-connecting link — lands on
  // top of the attempt the user is actually waiting for.
  const attemptRef = React.useRef(0);
  const linkRef = React.useRef<PeerLink | null>(null);

  const adopt = React.useCallback((connected: PeerLink) => {
    linkRef.current?.close();
    linkRef.current = connected;
    setLink(connected);
    setStatus("Connected to the other computer.");
    connected.onClose(() => {
      if (linkRef.current !== connected) return;
      linkRef.current = null;
      setLink(null);
      setStatus("Connection lost.");
    });
  }, []);

  React.useEffect(() => () => {
    attemptRef.current += 1;
    pendingInviteRef.current?.cancel();
    linkRef.current?.close();
  }, []);

  const createInvite = React.useCallback(() => {
    void (async () => {
      const attempt = ++attemptRef.current;
      try {
        setStatus("Creating the invite code...");
        pendingInviteRef.current?.cancel();
        pendingInviteRef.current = null;
        const invite = await createPeerInvite();
        if (attempt !== attemptRef.current) {
          invite.cancel();
          return;
        }
        pendingInviteRef.current = invite;
        setLocalCode(invite.invite);
        setStatus("Send this code, paste the answer, then complete the connection.");
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Invite failed: ${describeError(error)}`);
      }
    })();
  }, []);

  const answerInvite = React.useCallback(() => {
    void (async () => {
      const attempt = ++attemptRef.current;
      try {
        setStatus("Answering the invite...");
        const { answer, connected } = await answerPeerInvite(remoteCode);
        if (attempt !== attemptRef.current) {
          void connected.then((stale) => stale.close(), () => {});
          return;
        }
        setLocalCode(answer);
        setStatus("Send this answer back; the connection completes by itself.");
        const connectedLink = await connected;
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Answer failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, remoteCode]);

  const completeConnection = React.useCallback(() => {
    void (async () => {
      const attempt = ++attemptRef.current;
      try {
        const invite = pendingInviteRef.current;
        if (!invite) throw new Error("create an invite code first");
        setStatus("Completing the connection...");
        const connectedLink = await invite.acceptAnswer(remoteCode);
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        pendingInviteRef.current = null;
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Connection failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, remoteCode]);

  const disconnect = React.useCallback(() => {
    attemptRef.current += 1;
    pendingInviteRef.current?.cancel();
    pendingInviteRef.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    setLink(null);
    setLocalCode("");
    setRemoteCode("");
    setStatus("Not connected.");
  }, []);

  return {
    localCode,
    remoteCode,
    status,
    link,
    setRemoteCode,
    createInvite,
    answerInvite,
    completeConnection,
    disconnect,
  };
}
