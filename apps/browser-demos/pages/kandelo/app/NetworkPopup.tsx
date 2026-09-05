// Network popup — the three steps that connect two Kandelo computers.
//
// The humans carry the codes: one side creates an invite, the other answers
// it, the first completes. Both codes are plain text so they travel through
// whatever chat window the two people already share.

import * as React from "react";
import type { PeerSession } from "./peer-session";

export const NetworkPopup: React.FC<{
  session: PeerSession;
  sharing: boolean;
}> = ({ session, sharing }) => {
  const connected = session.link !== null;
  return (
    <div className="knetwork-popup">
      <section className="knetwork-section">
        <div className="knetwork-label">Connect another computer</div>
        <div className="knetwork-steps">
          <button
            type="button"
            className="knetwork-button"
            onClick={session.createInvite}
          >
            Create invite code
          </button>
          <button
            type="button"
            className="knetwork-button"
            onClick={session.answerInvite}
          >
            Answer invite
          </button>
          <button
            type="button"
            className="knetwork-button"
            onClick={session.completeConnection}
          >
            Complete connection
          </button>
        </div>
      </section>

      <section className="knetwork-section">
        <label className="knetwork-label" htmlFor="knetwork-local">
          Your code — send this to the other computer
        </label>
        <textarea
          id="knetwork-local"
          className="knetwork-code"
          readOnly
          spellCheck={false}
          value={session.localCode}
          placeholder="Your invite or answer code appears here."
        />
      </section>

      <section className="knetwork-section">
        <label className="knetwork-label" htmlFor="knetwork-remote">
          Their code — paste what you received
        </label>
        <textarea
          id="knetwork-remote"
          className="knetwork-code"
          spellCheck={false}
          value={session.remoteCode}
          placeholder="Paste the code you received."
          onChange={(event) => session.setRemoteCode(event.target.value)}
        />
      </section>

      <div className="knetwork-status" role="status">
        {session.status}
        {connected && sharing
          ? " Sharing this machine's terminals."
          : connected
            ? " No terminal open here yet; open one to share it."
            : ""}
      </div>

      {connected && (
        <button
          type="button"
          className="knetwork-button knetwork-disconnect"
          onClick={session.disconnect}
        >
          Disconnect
        </button>
      )}
    </div>
  );
};
