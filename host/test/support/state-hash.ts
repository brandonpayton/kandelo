import type { MachineCheckpoint } from "../../src/migration/checkpoint";

/**
 * A digest of everything a Kandelo machine holds, region by region.
 *
 * Silent divergence is what makes replication hard to trust: two computers
 * that stop being the same machine keep running and keep looking fine. This
 * module is the instrument that catches it. It is deliberately built before
 * the machine is deterministic, because its first job is to measure how far
 * from deterministic the machine already is.
 *
 * The hash is taken region by region rather than over one flat image. A single
 * digest can only say "different", which is not enough to act on. A per-region
 * digest names the kernel, the filesystem, or one process, so a mismatch
 * points at the subsystem that produced it.
 *
 * A hash is bound to the log position it was taken at. Two hashes from
 * different positions describe two different moments, and comparing them says
 * nothing about divergence, so the comparison refuses instead.
 *
 * The design is `docs/plans/2026-08-23-state-machine-replication-design.md`
 * § "Divergence detection and resync".
 */

/**
 * The version of this digest layout.
 *
 * A hash crosses the network and is compared against one a different build
 * produced. A comparison refuses a layout it does not know rather than
 * reporting a mismatch that only means the two sides hashed different things.
 */
export const MACHINE_STATE_HASH_FORMAT = 1;

/** One named part of a machine, and the digest of its bytes. */
export interface MachineStateDigest {
  readonly region: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Every region of one machine, at one log position. */
export interface MachineStateHash {
  readonly format: typeof MACHINE_STATE_HASH_FORMAT;
  /** The log position this machine had consumed when it was hashed. */
  readonly seq: number;
  readonly regions: readonly MachineStateDigest[];
  /** Over the region digests in order, so one value can be exchanged first. */
  readonly sha256: string;
}

const hex = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let index = 0; index < view.length; index++) {
    out += view[index]!.toString(16).padStart(2, "0");
  }
  return out;
};

async function digest(bytes: Uint8Array): Promise<string> {
  // WHY: `crypto.subtle` is the one strong digest both hosts have, and it
  // rejects a SharedArrayBuffer-backed view. A checkpoint's regions are
  // already detached copies, so copy only when a caller hands us a live view.
  const detached: Uint8Array<ArrayBuffer> = bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : new Uint8Array(bytes);
  return hex(await crypto.subtle.digest("SHA-256", detached));
}

/**
 * Hash a captured machine, region by region.
 *
 * The checkpoint is the machine's state, so hashing it needs no second
 * definition of what "the machine" is and cannot drift from what a replica
 * actually adopts. Regions are emitted in a fixed order — kernel, filesystem,
 * then processes by ascending pid — so two hosts that captured the same
 * machine produce comparable lists without agreeing on anything else.
 */
export async function hashMachineCheckpoint(
  checkpoint: MachineCheckpoint,
  seq: number,
): Promise<MachineStateHash> {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("a machine state hash names a non-negative log position");
  }
  const regions: MachineStateDigest[] = [
    {
      region: "kernel",
      bytes: checkpoint.kernelMemory.byteLength,
      sha256: await digest(checkpoint.kernelMemory),
    },
  ];
  // One region per mount, in mount order: two machines agree on their files
  // only if every filesystem matches, and a divergence should name the mount
  // it is on rather than hide inside one combined digest.
  for (const mount of checkpoint.filesystems) {
    regions.push({
      region: `filesystem:${mount.mountPoint}`,
      bytes: mount.bytes.byteLength,
      sha256: await digest(mount.bytes),
    });
  }
  const processes = [...checkpoint.processes]
    .sort((left, right) => left.pid - right.pid);
  for (const bucket of processes) {
    regions.push({
      region: `process:${bucket.pid}`,
      bytes: bucket.memory.byteLength,
      sha256: await digest(bucket.memory),
    });
  }

  const encoder = new TextEncoder();
  const overall = await digest(encoder.encode(
    regions.map((r) => `${r.region}:${r.bytes}:${r.sha256}`).join("\n"),
  ));
  return {
    format: MACHINE_STATE_HASH_FORMAT,
    seq,
    regions,
    sha256: overall,
  };
}

/** One region that two machines do not agree on. */
export interface RegionDivergence {
  readonly region: string;
  /** Null when the region is absent on that side, which is itself divergence. */
  readonly primary: MachineStateDigest | null;
  readonly replica: MachineStateDigest | null;
}

/** What two machines at the same log position disagree about. */
export interface MachineDivergenceReport {
  readonly seq: number;
  readonly diverged: boolean;
  readonly regions: readonly RegionDivergence[];
  /** One line naming the position and the regions, for a log or the UI. */
  readonly summary: string;
}

function describeSide(digest: MachineStateDigest | null): string {
  return digest === null
    ? "absent"
    : `${digest.sha256.slice(0, 12)} (${digest.bytes} bytes)`;
}

/**
 * Compare two machines that should be identical, and name what is not.
 *
 * A mismatch is a platform defect every time, so the report is built to be
 * acted on: it names the log position and every region that differs, and it
 * treats a region present on one side only as divergence rather than skipping
 * it.
 */
export function compareMachineStateHashes(
  primary: MachineStateHash,
  replica: MachineStateHash,
): MachineDivergenceReport {
  if (
    primary.format !== MACHINE_STATE_HASH_FORMAT
    || replica.format !== MACHINE_STATE_HASH_FORMAT
  ) {
    throw new Error(
      `a machine state hash comparison needs format `
        + `${MACHINE_STATE_HASH_FORMAT}, got ${primary.format} and `
        + `${replica.format}`,
    );
  }
  if (primary.seq !== replica.seq) {
    throw new Error(
      `two machines hashed at different log positions cannot be compared: `
        + `${primary.seq} and ${replica.seq}`,
    );
  }

  const byRegion = new Map<
    string,
    { primary: MachineStateDigest | null; replica: MachineStateDigest | null }
  >();
  const order: string[] = [];
  const note = (
    side: "primary" | "replica",
    digests: readonly MachineStateDigest[],
  ): void => {
    for (const item of digests) {
      let pair = byRegion.get(item.region);
      if (pair === undefined) {
        pair = { primary: null, replica: null };
        byRegion.set(item.region, pair);
        order.push(item.region);
      }
      pair[side] = item;
    }
  };
  note("primary", primary.regions);
  note("replica", replica.regions);

  const regions: RegionDivergence[] = [];
  for (const region of order) {
    const pair = byRegion.get(region)!;
    if (
      pair.primary !== null
      && pair.replica !== null
      && pair.primary.sha256 === pair.replica.sha256
    ) {
      continue;
    }
    regions.push({ region, primary: pair.primary, replica: pair.replica });
  }

  if (regions.length === 0) {
    return {
      seq: primary.seq,
      diverged: false,
      regions,
      summary: `the two machines agree at log position ${primary.seq}`,
    };
  }
  return {
    seq: primary.seq,
    diverged: true,
    regions,
    summary: `the two machines diverged at log position ${primary.seq}: `
      + regions
        .map((item) =>
          `${item.region} ${describeSide(item.primary)} against `
            + describeSide(item.replica)
        )
        .join("; "),
  };
}
