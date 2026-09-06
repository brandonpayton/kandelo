// Peer session — the signalled link between two Kandelo machines.
//
// WHY: the connection outlives the popover that creates it. Holding the link,
// the codes and the status here means closing the Network popover does not
// drop a connection, and reopening it shows what is actually going on.
//
// Two ways to carry the same two strings. With a signalling server
// configured, the pair shares a session name and the server ferries the
// codes: one side hosts the name, the other joins it, and the connection
// completes by itself. Without one, the three manual steps remain: one side
// creates an invite code, the other answers it, the first completes. The
// server address comes from `?signalling=` or `VITE_SIGNALLING_URL`; a page
// URL is untrusted input, and a hostile address only ever receives the two
// session descriptions the manual flow already hands to a chat window.
import * as React from "react";
import {
  answerPeerInvite,
  createPeerInvite,
  type PeerInvite,
  type PeerLink,
} from "../../../lib/peer-link";
import {
  SESSION_NAME_RULE,
  postSessionAnswer,
  postSessionOffer,
  readSession,
  validSessionName,
  waitForSessionAnswer,
} from "../../../lib/peer-signalling";

function resolveSignallingServer(): string | null {
  const query = new URLSearchParams(window.location.search).get("signalling");
  const configured = query ?? (import.meta.env.VITE_SIGNALLING_URL as
    | string
    | undefined);
  if (!configured) return null;
  try {
    const url = new URL(configured, window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

const SIGNALLING_SERVER = resolveSignallingServer();

export interface PeerSession {
  /** Whether a signalling server is configured, and the name flow with it. */
  signalling: boolean;
  /** The session name the two computers agreed on. */
  sessionName: string;
  /** The code to hand to the other computer. */
  localCode: string;
  /** The code pasted from the other computer. */
  remoteCode: string;
  status: string;
  link: PeerLink | null;
  setSessionName: (name: string) => void;
  setRemoteCode: (code: string) => void;
  hostSession: () => void;
  joinSession: () => void;
  createInvite: () => void;
  answerInvite: () => void;
  completeConnection: () => void;
  disconnect: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function usePeerSession(): PeerSession {
  const [sessionName, setSessionName] = React.useState("");
  const [localCode, setLocalCode] = React.useState("");
  const [remoteCode, setRemoteCode] = React.useState("");
  // Empty while nothing is happening: the connect steps already say there is
  // no connection, so the status only ever reports progress or a failure.
  const [status, setStatus] = React.useState("");
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

  const hostSession = React.useCallback(() => {
    void (async () => {
      const attempt = ++attemptRef.current;
      const name = sessionName.trim();
      try {
        if (SIGNALLING_SERVER === null) {
          throw new Error("no signalling server is configured");
        }
        if (!validSessionName(name)) throw new Error(SESSION_NAME_RULE);
        setStatus(`Creating the invite for "${name}"...`);
        pendingInviteRef.current?.cancel();
        pendingInviteRef.current = null;
        const invite = await createPeerInvite();
        if (attempt !== attemptRef.current) {
          invite.cancel();
          return;
        }
        pendingInviteRef.current = invite;
        await postSessionOffer(SIGNALLING_SERVER, name, invite.invite);
        if (attempt !== attemptRef.current) return;
        setStatus(
          `Hosting "${name}". Tell the other computer the name; the `
          + "connection completes by itself.",
        );
        const answer = await waitForSessionAnswer(
          SIGNALLING_SERVER,
          name,
          () => attempt === attemptRef.current,
        );
        if (answer === null || attempt !== attemptRef.current) return;
        setStatus("Answer received; completing the connection...");
        const connectedLink = await invite.acceptAnswer(answer);
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        pendingInviteRef.current = null;
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Hosting failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, sessionName]);

  const joinSession = React.useCallback(() => {
    void (async () => {
      const attempt = ++attemptRef.current;
      const name = sessionName.trim();
      try {
        if (SIGNALLING_SERVER === null) {
          throw new Error("no signalling server is configured");
        }
        if (!validSessionName(name)) throw new Error(SESSION_NAME_RULE);
        setStatus(`Joining "${name}"...`);
        const { offer } = await readSession(SIGNALLING_SERVER, name);
        if (attempt !== attemptRef.current) return;
        const { answer, connected } = await answerPeerInvite(offer);
        if (attempt !== attemptRef.current) {
          void connected.then((stale) => stale.close(), () => {});
          return;
        }
        await postSessionAnswer(SIGNALLING_SERVER, name, answer);
        setStatus(`Answered "${name}"; the connection completes by itself.`);
        const connectedLink = await connected;
        if (attempt !== attemptRef.current) {
          connectedLink.close();
          return;
        }
        adopt(connectedLink);
      } catch (error) {
        if (attempt !== attemptRef.current) return;
        setStatus(`Joining failed: ${describeError(error)}`);
      }
    })();
  }, [adopt, sessionName]);

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
    setStatus("");
  }, []);

  return {
    signalling: SIGNALLING_SERVER !== null,
    sessionName,
    localCode,
    remoteCode,
    status,
    link,
    setSessionName,
    setRemoteCode,
    hostSession,
    joinSession,
    createInvite,
    answerInvite,
    completeConnection,
    disconnect,
  };
}
