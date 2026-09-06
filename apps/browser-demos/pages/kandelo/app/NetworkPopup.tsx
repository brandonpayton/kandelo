// Network popup — the three steps that connect two Kandelo computers.
//
// The humans carry the codes: one side creates an invite, the other answers
// it, the first completes. Both codes are plain text so they travel through
// whatever chat window the two people already share.

import * as React from "react";
import type { MachineHandover } from "./machine-handover";
import type { MachineReplication } from "./machine-replication";
import type { PeerSession } from "./peer-session";
import type { FramebufferSharing } from "./shared-framebuffer";
import type { PrimarySurface } from "../../../../../web-libs/kandelo-session/src/kernel-host";

/**
 * Say what the other computer is being shown, or why it is being shown
 * nothing.
 *
 * One machine sends one surface: the one its holder is presenting. Two of the
 * five have a mirror, and the rest are gaps rather than subtleties, so each
 * says which surface it is and that the surface has none. A viewer looking at
 * an empty page is owed the reason, and "nothing is drawing yet" is the wrong
 * one when a fluid simulation is drawing at sixty frames a second through a
 * device this build cannot forward.
 */
function surfaceSummary(
  presenting: PrimarySurface,
  terminal: boolean,
  screen: FramebufferSharing,
): string {
  switch (presenting) {
    case "terminal":
      return terminal
        ? "Sharing this machine's terminal."
        : "No terminal open here yet; open one to share it.";
    case "framebuffer":
      if (screen.refusal) {
        return `This machine's screen cannot be mirrored: ${screen.refusal}.`;
      }
      return screen.sharing
        ? "Sharing this machine's screen."
        : "Nothing is drawing to this machine's screen yet.";
    case "kms":
      return "This machine draws through /dev/dri/card0. That surface has no "
        + "mirror yet, so the other computer sees no screen. Handing the "
        + "machine over still works, and it draws there.";
    case "web":
      return "This machine's surface is a web preview, which has no mirror "
        + "yet, so the other computer sees no screen. Handing the machine "
        + "over still works.";
    case "syslog":
      return "You are looking at Internals, which is not a surface the other "
        + "computer can be shown. Open the terminal or the screen to share "
        + "one.";
  }
}

/**
 * Say which computer holds the machine, then what it is sharing.
 *
 * Holding the machine is what decides who types, so it is the first thing
 * either person needs and it leads. It is also the only place the pair is
 * named: the terminal on a watching computer says it is read-only, and this
 * says why, so neither has to guess which of the two they are.
 *
 * Then the surface, and last a sentence that is not a surface: the whole
 * machine can leave this computer. Someone sharing a screen should not learn
 * only afterwards that the peer could take the machine drawing it.
 *
 * A computer running a replica holds a machine and is still the watcher, so
 * it is named as one. Its machine is a copy of the other computer's, kept the
 * same by the decisions crossing the wire, and it may no more be typed into
 * than a mirrored screen may.
 */
function sharedSummary(
  hasMachine: boolean,
  peerHasMachine: boolean,
  presenting: PrimarySurface | null,
  terminal: boolean,
  screen: FramebufferSharing,
  machine: boolean,
  replication: MachineReplication,
): string {
  if (replication.replicating) {
    return "The other computer holds the machine, so it is the one that "
      + "types. This computer is running a copy of it, following the "
      + "decisions it makes rather than the pixels it draws. Take it over to "
      + "run it here and type into it.";
  }
  if (!hasMachine || presenting === null) {
    return peerHasMachine
      ? "The other computer holds the machine, so it is the one that types. "
        + "You are watching it. Take it over to run it here and type into it."
      : "Neither computer is running a machine yet.";
  }

  const lines = [
    "You hold the machine, so you are the one that types; the other computer "
    + "is watching.",
    replication.publishing
      ? "The other computer is running a copy of this machine, following "
        + "every decision this one makes."
      : surfaceSummary(presenting, terminal, screen),
  ];
  if (machine) {
    lines.push(
      "The other computer can take this machine over; it would then run "
      + "there and type there, and stop here.",
    );
  }
  return lines.join(" ");
}

/**
 * Report a take that is running or one that did not finish.
 *
 * Null while nothing is happening: the button already says what it does, so
 * an idle note only repeats it. A failure has to stay visible, because the
 * machine is still on the other computer and the person needs to know why.
 */
function takeNote(handover: MachineHandover): string | null {
  if (handover.failure) return `Take over failed: ${handover.failure}`;
  if (handover.taking) {
    return "Freezing it on the other computer and restoring it here.";
  }
  return null;
}

export const NetworkPopup: React.FC<{
  session: PeerSession;
  sharingTerminal: boolean;
  sharingScreen: FramebufferSharing;
  handover: MachineHandover;
  /**
   * Whether this computer can adopt the peer's machine.
   *
   * True only when this computer runs none and the other says it runs one.
   * One computer holds a machine at a time, so taking a second would either
   * discard this one or run two copies of one state; and a take aimed at a
   * computer holding nothing would sit until it timed out. Both halves change
   * with every handover, so this side of the button follows the machine
   * instead of being decided when the two computers connected.
   */
  canTakeMachine: boolean;
  /**
   * Whether a machine runs on this computer.
   *
   * A computer with no machine has nothing to share, so it is offered only the
   * half of the exchange it can carry out: accepting someone else's invite.
   */
  hasMachine: boolean;
  /**
   * The surface the person holding this machine is presenting, or null when
   * this computer holds none.
   *
   * One machine sends one surface, and this is the one. It decides what the
   * other computer is shown, so it also decides what this popup reports.
   */
  presenting: PrimarySurface | null;
  /**
   * Whether one machine is running on both computers, and which side this is.
   *
   * It changes who this computer is more than what it is showing: a viewer
   * running a replica holds a machine and still cannot type into it, and a
   * summary derived from "does this computer hold a machine" alone would tell
   * that person the opposite.
   */
  replication: MachineReplication;
}> = ({
  session,
  sharingTerminal,
  sharingScreen,
  handover,
  canTakeMachine,
  hasMachine,
  presenting,
  replication,
}) => {
  const connected = session.link !== null;
  const note = takeNote(handover);

  // The grant is the machine owner's: joining starts by sending the machine's
  // whole state to the other computer, so the person holding it decides how
  // it may be followed — before completing the connection, and at any time
  // after.
  const grantSection = (
    <section className="knetwork-section">
      <div className="knetwork-label">They can</div>
      <div className="knetwork-link-controls">
        <button
          type="button"
          className="knetwork-button knetwork-grant"
          aria-pressed={replication.grant === "watch"}
          onClick={() => replication.setGrant("watch")}
        >
          Watch
        </button>
        <button
          type="button"
          className="knetwork-button knetwork-grant"
          aria-pressed={replication.grant === "join"}
          onClick={() => replication.setGrant("join")}
        >
          Join
        </button>
      </div>
      <div className="knetwork-grant-note">
        Watch shares this screen only; Join lets the other computer run a copy
        of this machine.
      </div>
    </section>
  );

  const localCodeSection = (
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
  );

  const remoteCodeSection = (
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
  );

  // Codes buy the connection, and the connection is bought. Leaving the steps
  // and the two code boxes on screen afterwards offers a purchase already made
  // and puts the way to break the link next to three ways to remake it.
  if (connected) {
    return (
      <div className="knetwork-popup">
        <div className="knetwork-status" role="status">
          {session.status}{" "}
          {sharedSummary(
            hasMachine,
            handover.peerHasMachine,
            presenting,
            sharingTerminal,
            sharingScreen,
            handover.offering,
            replication,
          )}
        </div>
        {replication.failure !== null && (
          <div className="knetwork-replication-note" role="status">
            {`Running a copy of this machine has not worked yet, and this `
              + `computer keeps asking: ${replication.failure}`}
          </div>
        )}

        {/* A replicating page holds a machine and is still the watcher, so
            holding one is not enough — the grant is offered to the page the
            machine is actually running on. */}
        {hasMachine && !replication.replicating && grantSection}

        <section className="knetwork-section">
          <div className="knetwork-link-controls">
            <button
              type="button"
              className="knetwork-button"
              onClick={session.disconnect}
            >
              Disconnect
            </button>
            {canTakeMachine && (
              <button
                type="button"
                className="knetwork-button knetwork-take"
                onClick={handover.take}
                disabled={handover.taking}
              >
                {handover.taking ? "Taking it over..." : "Take over this machine"}
              </button>
            )}
          </div>
          {canTakeMachine && note !== null && (
            <div className="knetwork-take-note" role="status">{note}</div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="knetwork-popup">
      <section className="knetwork-section">
        <div className="knetwork-label">Connect another computer</div>
        <div className="knetwork-steps">
          {/* Each computer is shown one side of the exchange, decided by
              whether it runs a machine. Inviting means offering a machine, so
              a computer running none has nothing to invite anyone to; and a
              computer already running one has something to offer, so answering
              someone else's invite is not the step in front of it. Showing
              both sides to either computer offers two ways to start and makes
              the pair agree by hand on which of them is which. */}
          {hasMachine ? (
            <button
              type="button"
              className="knetwork-button"
              onClick={session.createInvite}
            >
              Create invite code
            </button>
          ) : (
            <button
              type="button"
              className="knetwork-button"
              onClick={session.answerInvite}
            >
              Answer invite
            </button>
          )}
        </div>
      </section>

      {hasMachine && grantSection}
      {hasMachine && (
        <section className="knetwork-section">
          <div className="knetwork-steps">
            <button
              type="button"
              className="knetwork-button"
              onClick={session.completeConnection}
            >
              Complete connection
            </button>
          </div>
        </section>
      )}

      {hasMachine ? localCodeSection : remoteCodeSection}
      {hasMachine ? remoteCodeSection : localCodeSection}

      <div className="knetwork-status" role="status">{session.status}</div>
    </div>
  );
};
