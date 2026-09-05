// Machine handover — this machine, moved whole to the other computer.
//
// WHY: a mirror shows a machine but never moves one. The framebuffer and the
// terminal mirrors leave every process where it is, so the keeper keeps
// running and the viewer only watches. Handover is the other half: the keeper
// freezes its machine, sends the checkpoint together with the boot descriptor
// naming the image those processes run on, and gives this computer up. The
// taker boots that image, restores the checkpoint into it, and the same
// processes carry on there — a game of fbDOOM included, from the frame it was
// frozen on.
//
// The descriptor travels with the checkpoint because a viewer holds no image
// of its own. The tab-to-tab demo omits it: both of its tabs hardcode one
// image, so both already agree on what to boot.
//
// One computer holds the machine at a time. The keeper gives it up only after
// the checkpoint has gone out, and the taker adopts only after it has
// arrived, so a transfer that fails leaves the machine where it started
// rather than running in two places.
//
// Which computer that is decides who types, so it must be able to change more
// than once and in both directions: the person watching takes the machine,
// types, and hands it back the same way. Both sides therefore follow the
// peer's announcement of whether it holds a machine rather than a role fixed
// when the two computers first connected.
import * as React from "react";
import { LocalCheckpointHandover } from "@host/migration/transport-local";
import { validateBootDescriptor } from "../../../../../web-libs/kandelo-session/src/boot-descriptor";
import { useStatus } from "../kernel-host/react";
import type {
  BootDescriptor,
  CapturedMachine,
  KernelHost,
} from "../../../../../web-libs/kandelo-session/src/kernel-host";
import type { PeerLink } from "../../../lib/peer-link";

/**
 * How long a taker waits for the keeper's machine.
 *
 * A freeze unwinds every process before it can read one, and the checkpoint
 * then crosses the wire in chunks, so the wait is generous. It is bounded all
 * the same: a keeper that never answers has to read as a failed handover, not
 * as one still in progress.
 */
const TAKE_TIMEOUT_MS = 120_000;

export interface MachineHandover {
  /** True while this machine answers the peer's requests for it. */
  readonly offering: boolean;
  /** True while the other computer says it holds a machine. */
  readonly peerHasMachine: boolean;
  /**
   * True from the moment this computer gave its machine away until it holds
   * one again.
   *
   * A computer with no machine is otherwise indistinguishable from one that
   * never had one, and the two should not be shown the same page: the person
   * who handed a machine over chose to, and is waiting for it to start on the
   * other computer rather than waiting for someone to share something.
   */
  readonly handedOver: boolean;
  /** True while this computer is asking the peer for its machine. */
  readonly taking: boolean;
  /** Why the last attempt failed, or null when none has. */
  readonly failure: string | null;
  /** Ask the peer for its machine and run it here. */
  take(): void;
}

export function useMachineHandover(
  host: KernelHost,
  link: PeerLink | null,
): MachineHandover {
  const status = useStatus();
  const [taking, setTaking] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [peerHasMachine, setPeerHasMachine] = React.useState(false);
  const [handedOver, setHandedOver] = React.useState(false);

  // The transport wraps the link's channel; the link owns and closes it, so
  // dropping a transport here must not close the channel underneath it.
  const handover = React.useMemo(
    () =>
      link
        ? new LocalCheckpointHandover<CapturedMachine, BootDescriptor>(
          link.handover,
        )
        : null,
    [link],
  );

  // A computer with no link has no peer to hold anything. Clearing on the way
  // in as well as on the way out keeps a dropped link from leaving a stale
  // take-over button behind.
  React.useEffect(() => {
    setPeerHasMachine(false);
    if (!handover) return;
    let prewarmed: string | null = null;
    const stop = handover.watchKeeper((holding, offered) => {
      setPeerHasMachine(holding);
      if (!holding || offered === null) return;
      // The keeper's descriptor is another computer's input, and prewarming it
      // makes this page fetch what it names. Check it exactly as the take does
      // before it boots one, and as a shared URL's is checked.
      try {
        validateBootDescriptor(offered);
      } catch {
        return;
      }
      // Once per image. A keeper announces on every probe, and re-fetching a
      // machine's image each time it says hello would spend more than the wait
      // it is meant to save.
      if (prewarmed === offered.id) return;
      prewarmed = offered.id;
      // Nothing has been asked for yet, so a prewarm that fails is not a
      // failure to report: the take that follows fetches for itself and
      // reports it then, where a person is waiting for an answer.
      void host.prewarmBootDescriptor(offered).catch(() => {});
    });
    return () => {
      stop();
      setPeerHasMachine(false);
    };
  }, [handover, host]);

  // Holding a machine ends any earlier handover: this computer is running one
  // again, whether it booted it or took it back.
  React.useEffect(() => {
    if (status === "running") setHandedOver(false);
  }, [status]);

  // Losing the link ends it too. Without a peer there is no machine starting
  // elsewhere to wait for, so the page is back to having nothing.
  React.useEffect(() => {
    if (!handover) setHandedOver(false);
  }, [handover]);

  React.useEffect(() => {
    if (!handover || status !== "running") return;
    return handover.offer(
      () => host.captureMachine(),
      () => {
        // The machine runs on the other computer now. Give this one up
        // rather than keep a second copy diverging from one state.
        setHandedOver(true);
        void host.releaseMachine();
      },
      // Says which image this machine runs, so the computer watching can load
      // it before it asks for the machine. It is the same descriptor a take
      // would deliver, sent early and on its own: naming an image is not
      // handing one over, and a viewer that never takes has only fetched
      // something it could have fetched anyway.
      () => host.getBootDescriptor(),
    );
  }, [handover, host, status]);

  const take = React.useCallback(() => {
    if (!handover) return;
    setTaking(true);
    setFailure(null);
    void (async () => {
      try {
        const machine = await handover.take(TAKE_TIMEOUT_MS);
        // A descriptor from the peer is another computer's input. Check it
        // the way a shared URL's is checked, before this page boots an image
        // it names. The checkpoint itself is validated by the restore that
        // consumes it, in host/src/migration/restore.ts.
        validateBootDescriptor(machine.boot);
        // The terminals travel with the machine so the restored processes
        // arrive already reachable, and so this computer redraws the screen
        // the other one was showing instead of a fresh one. `adoptMachine`
        // checks them, as it is the layer that acts on them.
        await host.adoptMachine(
          machine.boot,
          machine.checkpoint,
          machine.terminals,
        );
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      } finally {
        setTaking(false);
      }
    })();
  }, [handover, host]);

  return {
    offering: handover !== null && status === "running",
    peerHasMachine,
    handedOver,
    taking,
    failure,
    take,
  };
}
