// Machine replication — one machine, running on both computers at once.
//
// WHY: a mirror sends the user's pixels and the viewer paints them, so the
// viewer's computer runs nothing and can show only what the user is looking
// at. Replication sends the user's decisions instead. The viewer restores the
// user's checkpoint into a machine of its own, then runs that machine on the
// values the user's host produced — clock readings, pointer movement — so the
// two stay the same machine while each renders its own screen. That is what
// lets a viewer see a machine it did not start, at its own window size,
// without a frame crossing the wire.
//
// It starts as soon as the link opens, on both sides, because which side is
// which is already known: the computer holding a machine is the user, and the
// computer holding none is the viewer. Neither has anything to press.
//
// A viewer holds a machine while it replicates, but it is not a second machine
// to take: it is a copy of the user's, and the log is what keeps it one. So a
// replicating viewer goes on announcing that it holds nothing, take-over goes
// on meaning "take the user's machine", and a take-over swaps the two roles —
// the taker's replica is replaced by the machine itself, the giver is left
// holding none, and replication starts again the other way round.
//
// Which is why the roles are a state machine here rather than a reading of the
// page's status. Replication moves that status itself: a viewer's machine goes
// from idle to running because this module booted it, and a rule that read the
// status alone would take that for a viewer becoming a user.
//
// A replica lasts exactly as long as the machine it copies. The user launches
// a different demo, or closes the page, and the recording ends; the copy is
// then a machine no computer is deciding for, so this page lets go of it and
// is the viewer again — which is what sends it to ask for whatever the other
// computer is running now.
//
// Two boundaries are reported rather than worked around. A machine whose guest
// owns the GL context cannot be read at all — `captureMachineCheckpoint`
// refuses it — so a modeset demo cannot be replicated, and the viewer is told
// that instead of being shown pixels pretending to be a machine. And a replica
// that reaches the end of the user's log stops there: it does not read its own
// clock, so a user who walks away leaves a viewer parked mid-instruction
// rather than drifting into a different machine.
import * as React from "react";
import { LocalReplicationLog } from "@host/replication/log-local";
import {
  ReplicationLogQueueWriter,
  createReplicationLogQueue,
} from "@host/replication/log-queue";
import { validateBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import type { ReplicationLogEntry } from "@host/replication/log";
import type {
  CapturedMachine,
  KernelHost,
  MachineStatus,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PeerLink } from "../../../lib/peer-link";

/**
 * How long a viewer waits for the user's machine.
 *
 * A read freezes every process before it can answer, and the checkpoint then
 * crosses the wire in chunks, so the wait matches the handover's. It is bounded
 * all the same: a user that never answers has to read as a replication that
 * failed, not as one still starting.
 */
const JOIN_TIMEOUT_MS = 120_000;

/**
 * How long a viewer waits before asking again.
 *
 * Most of the ways a join fails are conditions that pass. A machine is read by
 * freezing it, and a process that makes no syscall reaches no freeze hook, so
 * an idle machine refuses to be read until someone touches it; a machine that
 * is still booting has nothing to read yet. A viewer that gave up on the first
 * refusal would watch pixels for the rest of the session because the other
 * person happened to be reading their screen when it asked.
 *
 * Longer than the freeze's own 10-second unwind wait, so a viewer asking again
 * costs the other computer one bounded attempt at a time rather than a
 * continuous one.
 */
const RETRY_AFTER_MS = 15_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface MachineReplication {
  /** True while this machine's decisions are being sent to the viewer. */
  readonly publishing: boolean;
  /**
   * True from asking the user for its machine until this one is running it.
   *
   * A replica arriving and a machine being taken over are two boots of the
   * same page, and the second to start wins: the page ends up running one of
   * them while both computers believe they got the other. So the take is not
   * offered during this, and it comes back the moment the replica is up.
   */
  readonly joining: boolean;
  /** True while this machine is running on the user's decisions. */
  readonly replicating: boolean;
  /** Why replication is not running, or null when nothing refused it. */
  readonly failure: string | null;
}

const IDLE: MachineReplication = {
  publishing: false,
  joining: false,
  replicating: false,
  failure: null,
};

export function useMachineReplication(
  host: KernelHost,
  link: PeerLink | null,
): MachineReplication {
  const [publishing, setPublishing] = React.useState(false);
  const [joining, setJoining] = React.useState(false);
  const [replicating, setReplicating] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  React.useEffect(() => {
    setPublishing(false);
    setJoining(false);
    setReplicating(false);
    setFailure(null);
    if (!link) return;
    // The transport wraps the link's channel; the link owns and closes it, so
    // dropping a transport here must not close the channel underneath it.
    const wire = new LocalReplicationLog<CapturedMachine>(link.replication);

    let role: "none" | "user" | "viewer" = "none";
    let leaveRole: (() => void) | null = null;
    // True while this module is the reason the page's status is moving, which
    // is the one status change that must not be read as a change of role.
    let bootingReplica = false;
    let gone = false;

    const becomeUser = () => {
      role = "user";
      const stopServing = wire.serve(async (publish) => {
        const joined = await host.captureMachineForViewer((entries) => {
          publish(entries as readonly ReplicationLogEntry[]);
        });
        if (joined === null) return null;
        setPublishing(true);
        return {
          machine: joined.machine,
          stop: async () => {
            setPublishing(false);
            await joined.stop();
          },
        };
      });
      leaveRole = () => {
        stopServing();
        setPublishing(false);
      };
    };

    const becomeViewer = () => {
      role = "viewer";
      let replica = false;
      // One attempt's queue and its subscription, held so leaving the role can
      // release a replica parked on it. A parked kernel worker answers nothing
      // at all, so a page that let go of a quiet user without ending the queue
      // would hold a machine it could never ask to stop.
      let attempt: { end: () => void } | null = null;
      const endAttempt = () => {
        const ending = attempt;
        attempt = null;
        ending?.end();
      };
      /**
       * Let go of the copy this page is running, because it copies nothing now.
       *
       * The other computer stopped recording — it launched a different demo, or
       * its machine went away — and a replica taken off its log is not a machine
       * anyone decides for. Left alone it would carry on as one: its guests read
       * a clock that has no answer, they die, `init` starts fresh ones, and this
       * page ends up holding a machine of its own that it can type into while
       * still calling itself the viewer.
       *
       * Dropping it puts this page back where it started, which is also what
       * makes it pick the replacement up: it holds nothing, so it is the viewer
       * again, and the loop below asks the other computer for whatever it is
       * running now.
       */
      const dropReplica = () => {
        if (!replica) return;
        replica = false;
        setReplicating(false);
        void host.stopReplicatingMachine();
      };
      leaveRole = () => {
        setJoining(false);
        endAttempt();
        dropReplica();
      };
      void (async () => {
        while (!gone && role === "viewer") {
          setJoining(true);
          // A fresh queue per attempt. A publisher that stops recording ends
          // the one it was feeding, and a replica handed an ended queue would
          // reach the end of the log on its first clock read.
          const queue = createReplicationLogQueue();
          const writer = new ReplicationLogQueueWriter(queue);
          // Watching before asking. The user starts recording inside the read
          // and sends decisions from that instant, so a viewer that asked
          // first would miss the ones its own state does not yet cover.
          const stopWatching = wire.watch({
            // Queue first, then the nudge. A keystroke or a resize needs no
            // guest request, so a replica whose guest sits at a prompt only
            // sees it when told the log grew.
            entries: (entries) => {
              writer.push(entries);
              host.drainReplicationReplay();
            },
            ended: () => {
              writer.end();
              dropReplica();
            },
            diverged: (error) => {
              writer.end();
              setFailure(error.message);
              dropReplica();
            },
          });
          attempt = {
            end: () => {
              stopWatching();
              writer.end();
            },
          };
          try {
            const machine = await wire.join(JOIN_TIMEOUT_MS);
            if (gone || role !== "viewer") return;
            // The user's descriptor and terminals are another computer's
            // input. Check the descriptor exactly as a take does before this
            // page boots an image it names; `replicateMachine` checks the
            // terminals, as it is the layer that acts on them.
            validateBootDescriptor(machine.boot);
            bootingReplica = true;
            try {
              await host.replicateMachine(
                machine.boot,
                machine.checkpoint,
                machine.terminals,
                { entries: [], queue, release: () => writer.end() },
              );
            } finally {
              bootingReplica = false;
            }
            if (gone || role !== "viewer") return;
            replica = true;
            setJoining(false);
            setFailure(null);
            setReplicating(true);
            return;
          } catch (error) {
            if (gone || role !== "viewer") return;
            endAttempt();
            // Reported and then retried, not reported instead of retried. The
            // person watching is owed the reason their computer is not
            // running the machine yet, and the next attempt is what makes it
            // a reason rather than a verdict.
            setFailure(error instanceof Error ? error.message : String(error));
          }
          setJoining(false);
          await pause(RETRY_AFTER_MS);
        }
      })();
    };

    const leave = () => {
      const leaving = leaveRole;
      role = "none";
      leaveRole = null;
      leaving?.();
    };

    const decide = (status: MachineStatus) => {
      if (gone || bootingReplica) return;
      // A role lasts as long as the machine it was taken for. A user that no
      // longer holds one has nothing to publish; a viewer whose replica is
      // being replaced is being handed the machine itself.
      if (role !== "none" && status !== "running") leave();
      if (role !== "none") return;
      if (status === "running") becomeUser();
      else if (status === "idle") becomeViewer();
    };

    const stopStatus = host.subscribeStatus(decide);
    decide(host.getStatus());
    return () => {
      gone = true;
      stopStatus();
      leave();
    };
  }, [host, link]);

  if (!link) return IDLE;
  return { publishing, joining, replicating, failure };
}
