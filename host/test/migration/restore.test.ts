/**
 * Checkpoint validation against a real captured machine.
 *
 * Every corruption case starts from a genuine `captureCheckpointBytes` result,
 * so a refusal proves the validator catches the corruption rather than an
 * artifact of a hand-built fixture. The pristine clone validates at the end,
 * which proves the refusals came from the corruption alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import {
  DEFAULT_MOUNT_SPEC,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import { findRepoRoot, resolveBinary } from "../../src/binary-resolver";
import { doomSharewareWad } from "../support/doom-shareware";
import {
  ABI_VERSION,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
} from "../../src/generated/abi";
import { FORK_SAVE_BUFFER_SIZE } from "../../src/process-memory";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";
import {
  CheckpointRefusedError,
  describeCheckpointMountGaps,
  validateMachineCheckpoint,
} from "../../src/migration/restore";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const EXPECTED = { kernelAbiVersion: ABI_VERSION };

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function captureRealCheckpoint(
  program = "checkpoint-loop.wasm",
): Promise<MachineCheckpoint> {
  let ready = () => {};
  const isReady = new Promise<void>((resolve) => { ready = resolve; });
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    onStdout: (_pid, data) => {
      output += new TextDecoder().decode(data);
      if (output.includes("READY")) ready();
    },
  });
  await host.init();
  try {
    await new Promise<void>((resolve) => {
      void host.spawn(programBytes(program), [
        program.replace(/\.wasm$/, ""),
      ], { onStarted: () => resolve() });
    });
    await isReady;
    const response = await host.captureCheckpointBytes(TIMEOUTS);
    if (response.status !== "captured") {
      throw new Error(`capture failed: ${JSON.stringify(response)}`);
    }
    return response.checkpoint;
  } finally {
    await host.destroy();
  }
}

/** Deep copy so each corruption starts from the same captured machine. */
function cloneCheckpoint(checkpoint: MachineCheckpoint): MachineCheckpoint {
  return structuredClone(checkpoint);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("checkpoint validation", () => {
  it(
    "accepts a captured machine and refuses every corruption of it",
    { timeout: 60_000 },
    async () => {
      const captured = await captureRealCheckpoint();

      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), EXPECTED),
      ).resolves.toEqual(
        new Map(
          captured.processes.map((bucket) => [
            bucket.pid,
            expect.any(WebAssembly.Module),
          ]),
        ),
      );

      const refusal = async (
        corrupt: (checkpoint: Mutable<MachineCheckpoint>) => void,
        reason: string | RegExp,
      ) => {
        const checkpoint = cloneCheckpoint(captured) as
          Mutable<MachineCheckpoint>;
        corrupt(checkpoint);
        const attempt = validateMachineCheckpoint(checkpoint, EXPECTED);
        await expect(attempt).rejects.toThrow(CheckpointRefusedError);
        await expect(attempt).rejects.toThrow(reason);
      };

      await refusal((checkpoint) => {
        (checkpoint as { format: number }).format = 999;
      }, "unknown checkpoint format 999");

      await refusal((checkpoint) => {
        (checkpoint as { kernelAbiVersion: number }).kernelAbiVersion =
          ABI_VERSION + 1;
      }, `kernel ABI ${ABI_VERSION + 1} does not match`);

      await refusal((checkpoint) => {
        (checkpoint as { kernelMemory: Uint8Array }).kernelMemory =
          checkpoint.kernelMemory.subarray(0, 100);
      }, "not a whole number of pages");

      await refusal((checkpoint) => {
        (checkpoint as { filesystems: unknown }).filesystems = [
          { mountPoint: "/", bytes: new Uint8Array(0) },
        ];
      }, "the / mount is empty");

      await refusal((checkpoint) => {
        (checkpoint as { filesystems: unknown }).filesystems = [
          { mountPoint: "/home/maker", bytes: new Uint8Array([1]) },
        ];
      }, "no / mount was captured");

      // Two buckets for one mount leave the restore choosing which bytes win.
      await refusal((checkpoint) => {
        (checkpoint as { filesystems: unknown }).filesystems = [
          { mountPoint: "/", bytes: new Uint8Array([1]) },
          { mountPoint: "/home/maker", bytes: new Uint8Array([1]) },
          { mountPoint: "/home/maker", bytes: new Uint8Array([2]) },
        ];
      }, "appears twice");

      await refusal((checkpoint) => {
        (checkpoint as { filesystems: unknown }).filesystems = [
          { mountPoint: "/", bytes: new Uint8Array([1]) },
          { mountPoint: "home/maker", bytes: new Uint8Array([1]) },
        ];
      }, "is not absolute");

      // A mount cannot be both carried and left behind: a restore reading the
      // two lists would report a gap it just filled.
      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "/", reason: "no" }];
      }, "is both carried and unreadable");

      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "tmp", reason: "no" }];
      }, "is not absolute");

      // The reason is printed unaltered, and a peer wrote it.
      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "/tmp", reason: "x".repeat(201) }];
      }, "is 201 characters");

      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "/tmp", reason: "" }];
      }, "is 0 characters");

      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          undefined;
      }, "carries no unreadable-mount list");

      await refusal((checkpoint) => {
        (checkpoint as { processes: unknown[] }).processes = [
          checkpoint.processes[0]!,
          checkpoint.processes[0]!,
        ];
      }, /appears in more than one process bucket/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { memory: Uint8Array };
        bucket.memory = bucket.memory.subarray(1);
      }, /does not cover its whole buffer/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { ptrWidth: number };
        bucket.ptrWidth = 5;
      }, /claims pointer width 5/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { ptrWidth: number };
        bucket.ptrWidth = 8;
      }, /pointer width 8 but its program declares 4/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { argv: unknown };
        bucket.argv = new Array(PROCESS_STARTUP_MAX_ARGV_COUNT + 1).fill("a");
      }, /argv list is unusable/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { env: unknown };
        bucket.env = [7];
      }, /environment carries a non-string entry/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { env: unknown };
        bucket.env = ["x".repeat(PROCESS_METADATA_ENTRY_MAX_BYTES + 1)];
      }, /environment carries a 65537-byte entry/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { env: unknown };
        bucket.env = new Array(64).fill(
          "x".repeat(PROCESS_METADATA_ENTRY_MAX_BYTES),
        );
      }, /environment exceeds ARG_MAX/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as {
          programBytes: ArrayBuffer;
        };
        bucket.programBytes = new Uint8Array([1, 2, 3, 4]).buffer;
      }, /is not a WebAssembly module/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as {
          programBytes: ArrayBuffer;
        };
        // Magic and version only: a valid module with no capability claim.
        bucket.programBytes =
          new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer;
      }, /does not claim activation-state-safe replay/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { channelOffset: number };
        bucket.channelOffset = checkpoint.processes[0]!.memory.byteLength;
      }, /does not fit inside/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]!;
        new DataView(bucket.memory.buffer).setUint32(
          bucket.channelOffset - FORK_SAVE_BUFFER_SIZE,
          7,
          true,
        );
      }, /continuation root is unusable/);

      await refusal((checkpoint) => {
        (checkpoint as { monotonicNs: number }).monotonicNs = -1;
      }, /captured monotonic clock -1 is unusable/);

      await refusal((checkpoint) => {
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: 424242, addr: 0, len: 0, w: 8, h: 8, stride: 32,
            fmt: "BGRA32", hostBuffer: new Uint8Array(256) },
        ];
      }, /names pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: checkpoint.processes[0]!.pid, addr: 0, len: 0, w: 8, h: 8,
            stride: 32, fmt: "BGRA32", hostBuffer: new Uint8Array(7) },
        ];
      }, /carries 7 pixel bytes for a 256-byte frame/);

      await refusal((checkpoint) => {
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: checkpoint.processes[0]!.pid, addr: 4096, len: 256, w: 8,
            h: 8, stride: 32, fmt: "BGRA32", hostBuffer: new Uint8Array(256) },
        ];
      }, /carries host pixels/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]!;
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: bucket.pid, addr: bucket.memory.byteLength, len: 256, w: 8,
            h: 8, stride: 32, fmt: "BGRA32", hostBuffer: null },
        ];
      }, /framebuffer range does not fit inside/);

      // A modeset display bound to the captured machine's own process, which
      // every KMS corruption below starts from.
      const modeset = (checkpoint: MachineCheckpoint) => {
        const pid = checkpoint.processes[0]!.pid;
        return {
          fbs: [{
            fb_id: 10,
            bo_id: 100,
            width: 8,
            height: 8,
            pixel_format: 0x34325258,
            pitch: 32,
          }],
          crtcs: [{ crtc_id: 1, fb_id: 10 }],
          masterPid: pid,
          buffers: [{
            bo_id: 100,
            size: 256,
            w: 8,
            h: 8,
            stride: 32,
            pids: [pid],
            bindings: [{ pid, addr: 0, len: 256 }],
            pixels: new Uint8Array(256),
          }],
        };
      };

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.fbs[0]!.bo_id = 424242;
        checkpoint.kms = kms;
      }, /buffer object 424242, which the checkpoint does not carry/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.pixels = new Uint8Array(7);
        checkpoint.kms = kms;
      }, /carries 7 pixel bytes for a 256-byte buffer/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.pids = [424242];
        checkpoint.kms = kms;
      }, /held by pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.pids = [];
        checkpoint.kms = kms;
      }, /buffer object 100 is held by no process/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.bindings[0]!.pid = 424242;
        checkpoint.kms = kms;
      }, /mapped by pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.bindings[0]!.addr =
          checkpoint.processes[0]!.memory.byteLength;
        checkpoint.kms = kms;
      }, /mapping in pid \d+ does not fit inside/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.crtcs.push({ crtc_id: 1, fb_id: 10 });
        checkpoint.kms = kms;
      }, /CRTC 1 is bound twice/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.masterPid = 424242;
        checkpoint.kms = kms;
      }, /DRM master is pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        (checkpoint as { epolls: unknown }).epolls = undefined;
      }, "carries no epoll list");

      await refusal((checkpoint) => {
        checkpoint.epolls = [{ pid: 424242, epfd: 3, interests: [] }];
      }, /an epoll mirror names pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        checkpoint.epolls = [{
          pid: checkpoint.processes[0]!.pid,
          epfd: 3,
          interests: [{ fd: 4, events: 1, data: "not a number" }],
        }];
      }, /carries unusable data for fd 4/);

      await refusal((checkpoint) => {
        checkpoint.epolls = [
          { pid: checkpoint.processes[0]!.pid, epfd: 3, interests: [] },
          { pid: checkpoint.processes[0]!.pid, epfd: 3, interests: [] },
        ];
      }, /carries two mirrors for epoll fd 3/);

      // The corruptions above never touched the captured object itself.
      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), EXPECTED),
      ).resolves.toBeDefined();

      // DRM leaves a CRTC modeset when its framebuffer goes, so a CRTC naming
      // an absent fb_id is a real machine's state, not a broken record.
      const staleBinding = cloneCheckpoint(captured) as Mutable<MachineCheckpoint>;
      const kms = modeset(staleBinding);
      kms.fbs = [];
      staleBinding.kms = kms;
      await expect(
        validateMachineCheckpoint(staleBinding, EXPECTED),
      ).resolves.toBeDefined();
    },
  );

  it(
    "boots a machine from a checkpoint's kernel and filesystem",
    { timeout: 120_000 },
    async () => {
      const waldo = new TextEncoder().encode("waldo\n");
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      let keeperPid = -1;
      try {
        // A process that ran and exited advances the kernel's pid counter,
        // which lives in kernel memory. The receiver proves it adopted that
        // memory by allocating the next pid rather than starting over.
        await expect(
          keeper.spawn(programBytes("test-pthread.wasm"), ["test-pthread"], {
            onStarted: (pid) => { keeperPid = pid; },
          }),
        ).resolves.toBe(0);
        await keeper.writeFileToVfs("/etc/waldo", waldo);
        // The exited spawn's worker may still be tearing down, and a freeze
        // that meets that teardown fails with "the process ended during the
        // checkpoint freeze" — truthfully and reversibly, so retry it.
        let response = await keeper.captureCheckpointBytes(TIMEOUTS);
        for (
          let attempt = 0;
          attempt < 10
          && response.status === "failed"
          && response.reason.includes("ended during the checkpoint freeze");
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          response = await keeper.captureCheckpointBytes(TIMEOUTS);
        }
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
        expect(checkpoint.processes).toEqual([]);
      } finally {
        await keeper.destroy();
      }

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        // The filesystem is the captured one, not the image's fresh state.
        expect(await receiver.readFileFromVfs("/etc/waldo")).toEqual(waldo);

        // The restored machine is whole enough to be read again. Before the
        // spawn below: a capture that lands while an exited process is still
        // tearing down fails with "the process ended during the checkpoint
        // freeze", which is the freeze telling the truth, not this test's
        // subject.
        const second = await receiver.captureCheckpoint(TIMEOUTS);
        if (second.status !== "captured") {
          throw new Error(`second capture: ${JSON.stringify(second)}`);
        }

        let receiverPid = -1;
        await expect(
          receiver.spawn(programBytes("test-pthread.wasm"), ["test-pthread"], {
            onStarted: (pid) => { receiverPid = pid; },
          }),
        ).resolves.toBe(0);
        expect(receiverPid).toBeGreaterThan(keeperPid);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "refuses to boot from a checkpoint it cannot adopt",
    { timeout: 120_000 },
    async () => {
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
      } finally {
        await keeper.destroy();
      }

      const wrongAbi = cloneCheckpoint(checkpoint) as
        Mutable<MachineCheckpoint>;
      (wrongAbi as { kernelAbiVersion: number }).kernelAbiVersion =
        ABI_VERSION + 1;
      const refused = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: wrongAbi,
      });
      try {
        await expect(refused.init()).rejects.toThrow(
          `kernel ABI ${ABI_VERSION + 1} does not match`,
        );
      } finally {
        await refused.destroy().catch(() => undefined);
      }

    },
  );

  it(
    "says which filesystems a restored Node machine did not get",
    { timeout: 120_000 },
    async () => {
      const checkpoint = await captureRealCheckpoint();
      // Every scratch mount on Node is a HostFileSystem, so the capture read
      // `/` alone. A restore that reported nothing would present this machine
      // as whole when seven of its eight filesystems stayed behind.
      const diagnostics: string[] = [];
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        onHostDiagnostic: (diagnostic) => {
          if (diagnostic.source === "checkpoint restore") {
            diagnostics.push(diagnostic.message);
          }
        },
      });
      await receiver.init();
      try {
        expect(diagnostics).toHaveLength(1);
        for (const mountPoint of DEFAULT_MOUNT_SPEC.map((m) => m.path)) {
          if (mountPoint === "/") continue;
          expect(diagnostics[0]).toContain(mountPoint);
        }
        expect(diagnostics[0]).toContain(
          "a host directory backs this mount and owns no shared buffer",
        );
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a checkpointed process that keeps running",
    { timeout: 120_000 },
    async () => {
      const checkpoint = await captureRealCheckpoint();
      expect(checkpoint.processes.length).toBe(1);
      const pid = checkpoint.processes[0]!.pid;

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        expect(await receiver.signalProcess(pid, 0)).toBe(true);

        // The strongest liveness proof a checkpoint-loop guest offers: a
        // capture completes only when the process crosses a syscall boundary
        // and unwinds, so a captured recapture means the restored process
        // genuinely resumed its loop in the fresh instance.
        const recapture = await receiver.captureCheckpointBytes(TIMEOUTS);
        if (recapture.status !== "captured") {
          throw new Error(`recapture: ${JSON.stringify(recapture)}`);
        }
        expect(
          recapture.checkpoint.processes.map((bucket) => bucket.pid),
        ).toEqual([pid]);
      } finally {
        await receiver.destroy();
      }

      // A host whose memory configuration differs computes a different
      // process layout, and a captured image copied into the wrong layout
      // would put the channel and thread arena at the wrong addresses.
      const mismatched = new NodeKernelHost({
        rootfsImage: "default",
        maxPages: 4096,
        restoreCheckpoint: checkpoint,
      });
      try {
        await expect(mismatched.init()).rejects.toThrow(
          "does not match this host's computed",
        );
      } finally {
        await mismatched.destroy().catch(() => undefined);
      }
    },
  );

  it(
    "serves epoll_wait from a restored machine",
    { timeout: 120_000 },
    async () => {
      // The host answers epoll_pwait from its mirror of the interest list,
      // built by watching epoll_ctl. The captured guest registered its pipe
      // before the freeze, so the mirror must arrive with the checkpoint —
      // a restore without it answers EBADF and the guest's tick dies.
      const checkpoint = await captureRealCheckpoint("checkpoint-epoll.wasm");
      const pid = checkpoint.processes[0]!.pid;
      expect(checkpoint.epolls).toEqual([{
        pid,
        epfd: expect.any(Number),
        interests: [{
          fd: expect.any(Number),
          events: expect.any(Number),
          data: expect.any(String),
        }],
      }]);

      let output = "";
      let sawTick = () => {};
      const ticked = new Promise<void>((resolve) => { sawTick = resolve; });
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        onStdout: (_pid, data) => {
          output += new TextDecoder().decode(data);
          if (output.includes("TICK")) sawTick();
        },
      });
      await receiver.init();
      try {
        await ticked;
        expect(output).not.toContain("EPOLL_ERR");
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a running fbDOOM that keeps playing",
    { timeout: 180_000 },
    async () => {
      const fbdoomBytes = readFileSync(resolveBinary("programs/fbdoom.wasm"));
      const fbdoom = fbdoomBytes.buffer.slice(
        fbdoomBytes.byteOffset,
        fbdoomBytes.byteOffset + fbdoomBytes.byteLength,
      ) as ArrayBuffer;
      const wad = await doomSharewareWad();

      let ptyOutput = "";
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        onPtyOutput: (_pid, data) => {
          ptyOutput += new TextDecoder().decode(data);
        },
      });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        await keeper.writeFileToVfs("/doom1.wad", wad);
        await new Promise<void>((resolve) => {
          void keeper.spawn(fbdoom, ["fbdoom", "-iwad", "/doom1.wad"], {
            pty: true,
            env: ["AUDIODEV=/nonexistent-dsp"],
            onStarted: () => resolve(),
          });
        });
        await expect
          .poll(() => ptyOutput.includes("ST_Init"), { timeout: 60_000 })
          .toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
      } finally {
        await keeper.destroy();
      }
      expect(checkpoint.processes.length).toBe(1);
      const pid = checkpoint.processes[0]!.pid;
      // fbDOOM renders write-based, so the checkpoint carries the current
      // frame in a host-owned pixel buffer.
      expect(checkpoint.framebuffers.length).toBe(1);
      const capturedFb = checkpoint.framebuffers[0]!;
      expect(capturedFb.pid).toBe(pid);
      expect(capturedFb.addr).toBe(0);
      expect(capturedFb.hostBuffer).not.toBeNull();
      expect(capturedFb.hostBuffer!.byteLength).toBe(
        capturedFb.h * capturedFb.stride,
      );
      expect(capturedFb.hostBuffer!.some((byte) => byte !== 0)).toBe(true);

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        expect(await receiver.signalProcess(pid, 0)).toBe(true);

        // The game keeps playing only if it keeps crossing syscall
        // boundaries every tic; a capture completes only then, so a
        // captured recapture is the proof the demo loop resumed.
        const recapture = await receiver.captureCheckpointBytes(TIMEOUTS);
        if (recapture.status !== "captured") {
          throw new Error(`recapture: ${JSON.stringify(recapture)}`);
        }
        expect(
          recapture.checkpoint.processes.map((bucket) => bucket.pid),
        ).toEqual([pid]);
        // The receiver rebound the framebuffer: its own capture carries the
        // same binding, seeded and still receiving the game's writes.
        expect(recapture.checkpoint.framebuffers.length).toBe(1);
        const reboundFb = recapture.checkpoint.framebuffers[0]!;
        expect(reboundFb.pid).toBe(pid);
        expect(reboundFb.w).toBe(capturedFb.w);
        expect(reboundFb.h).toBe(capturedFb.h);
        expect(reboundFb.stride).toBe(capturedFb.stride);
        expect(reboundFb.hostBuffer!.some((byte) => byte !== 0)).toBe(true);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "routes terminal input and output to a restored process",
    { timeout: 120_000 },
    async () => {
      let keeperOutput = "";
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        onPtyOutput: (_pid, data) => {
          keeperOutput += new TextDecoder().decode(data);
        },
      });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        let spawnedPid = 0;
        await new Promise<void>((resolve) => {
          void keeper.spawn(programBytes("checkpoint-pty-echo.wasm"), [
            "checkpoint-pty-echo",
          ], {
            pty: true,
            onStarted: (startedPid) => {
              spawnedPid = startedPid;
              resolve();
            },
          });
        });
        await expect
          .poll(() => keeperOutput.includes("READY"), { timeout: 30_000 })
          .toBe(true);
        keeper.ptyWrite(spawnedPid, new TextEncoder().encode("a\n"));
        await expect
          .poll(() => keeperOutput.includes("GOT:a"), { timeout: 30_000 })
          .toBe(true);
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
      } finally {
        await keeper.destroy();
      }
      expect(checkpoint.processes.length).toBe(1);
      const pid = checkpoint.processes[0]!.pid;

      // Input written to the restored terminal must reach the process and
      // its tagged echo must come back: the captured machine's pid → PTY
      // routing died with it, so the receiver has to re-derive the pair
      // from the restored kernel memory.
      let restoredOutput = "";
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        onPtyOutput: (_pid, data) => {
          restoredOutput += new TextDecoder().decode(data);
        },
      });
      await receiver.init();
      try {
        receiver.ptyWrite(pid, new TextEncoder().encode("b\n"));
        await expect
          .poll(() => restoredOutput.includes("GOT:b"), { timeout: 30_000 })
          .toBe(true);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a checkpointed process whose pthread keeps running",
    { timeout: 120_000 },
    async () => {
      const checkpoint = await captureRealCheckpoint("checkpoint-threads.wasm");
      expect(checkpoint.processes.length).toBe(1);
      const bucket = checkpoint.processes[0]!;
      const pid = bucket.pid;
      expect(bucket.threadAllocator.activeCount).toBeGreaterThan(0);
      expect(bucket.threads.length).toBe(bucket.threadAllocator.activeCount);

      // A bucket whose thread records disagree with its allocator is refused
      // before anything is instantiated: a missing record would leave a live
      // thread's frames parked forever.
      const missingThread = cloneCheckpoint(checkpoint);
      (missingThread.processes[0]! as { threads: unknown[] }).threads = [];
      const missingAttempt = validateMachineCheckpoint(missingThread, EXPECTED);
      await expect(missingAttempt).rejects.toThrow(CheckpointRefusedError);
      await expect(missingAttempt).rejects.toThrow(/thread record\(s\)/);

      const brokenAnchor = cloneCheckpoint(checkpoint);
      const brokenThread = brokenAnchor.processes[0]!.threads[0]!;
      new DataView(brokenAnchor.processes[0]!.memory.buffer).setUint32(
        brokenThread.channelOffset - FORK_SAVE_BUFFER_SIZE,
        7,
        true,
      );
      const brokenAttempt = validateMachineCheckpoint(brokenAnchor, EXPECTED);
      await expect(brokenAttempt).rejects.toThrow(CheckpointRefusedError);
      await expect(brokenAttempt).rejects.toThrow(
        /tid \d+'s continuation root is unusable/,
      );

      const threadRefusal = async (
        corrupt: (thread: Record<string, unknown>) => void,
        reason: string | RegExp,
      ) => {
        const corrupted = cloneCheckpoint(checkpoint);
        corrupt(
          corrupted.processes[0]!.threads[0]! as
            unknown as Record<string, unknown>,
        );
        const attempt = validateMachineCheckpoint(corrupted, EXPECTED);
        await expect(attempt).rejects.toThrow(CheckpointRefusedError);
        await expect(attempt).rejects.toThrow(reason);
      };
      await threadRefusal((thread) => {
        thread.tid = pid;
      }, `carries a thread with kernel TID ${pid}`);
      await threadRefusal((thread) => {
        thread.channelOffset = checkpoint.processes[0]!.memory.byteLength;
      }, /syscall channel at \d+ does not fit inside/);

      const duplicateTid = cloneCheckpoint(checkpoint);
      const duplicated = duplicateTid.processes[0]! as unknown as {
        threads: unknown[];
        threadAllocator: { activeCount: number };
      };
      duplicated.threads = [
        duplicateTid.processes[0]!.threads[0]!,
        { ...duplicateTid.processes[0]!.threads[0]! },
      ];
      duplicated.threadAllocator = {
        ...duplicateTid.processes[0]!.threadAllocator,
        activeCount: 2,
      };
      const duplicateAttempt = validateMachineCheckpoint(
        duplicateTid,
        EXPECTED,
      );
      await expect(duplicateAttempt).rejects.toThrow(CheckpointRefusedError);
      await expect(duplicateAttempt).rejects.toThrow(
        /carries kernel TID \d+ twice/,
      );

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        expect(await receiver.signalProcess(pid, 0)).toBe(true);

        // A capture completes only when every task of the process crosses a
        // syscall boundary and unwinds, so a captured recapture proves the
        // restored pthread genuinely resumed its nap loop alongside the main
        // thread rather than staying parked in its captured frames.
        const recapture = await receiver.captureCheckpointBytes(TIMEOUTS);
        if (recapture.status !== "captured") {
          throw new Error(`recapture: ${JSON.stringify(recapture)}`);
        }
        const recaptured = recapture.checkpoint.processes.find(
          (candidate) => candidate.pid === pid,
        );
        expect(recaptured).toBeDefined();
        expect(recaptured!.threads.map((thread) => thread.tid)).toEqual(
          bucket.threads.map((thread) => thread.tid),
        );
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a file mid-write, a directory mid-iteration, and a pending alarm",
    { timeout: 120_000 },
    async () => {
      // The fixture needs a writable root: a checkpoint carries the
      // image-backed root filesystem, and scratch mounts do not travel.
      const spec: MountSpec[] = [
        { path: "/", source: "image", readonly: false },
      ];
      let keeperOut = "";
      let ready = () => {};
      const isReady = new Promise<void>((resolve) => { ready = resolve; });
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        rootfsMountSpec: spec,
        onStdout: (_pid, data) => {
          keeperOut += new TextDecoder().decode(data);
          if (keeperOut.includes("READY")) ready();
        },
        onStderr: (_pid, data) => {
          keeperOut += new TextDecoder().decode(data);
        },
      });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        await new Promise<void>((resolve) => {
          void keeper.spawn(
            programBytes("checkpoint-handles.wasm"),
            ["checkpoint-handles"],
            { onStarted: () => resolve() },
          );
        });
        await isReady;
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
        // The alarm is pending, the file half-written, the directory
        // mid-iteration: none of the completion markers may exist yet.
        expect(keeperOut).not.toContain("OK");
      } finally {
        await keeper.destroy();
      }

      let receiverOut = "";
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        rootfsMountSpec: spec,
        restoreCheckpoint: checkpoint,
        onStdout: (_pid, data) => {
          receiverOut += new TextDecoder().decode(data);
        },
        onStderr: (_pid, data) => {
          receiverOut += new TextDecoder().decode(data);
        },
      });
      await receiver.init();
      try {
        await expect
          .poll(() => receiverOut.includes("ALARM OK"), { timeout: 30_000 })
          .toBe(true);
        expect(receiverOut).toContain("MONO OK");
        expect(receiverOut).toContain("FILE OK");
        expect(receiverOut).toContain("DIR OK");
      } finally {
        await receiver.destroy();
      }
    },
  );
});

describe("what a restore says about the mounts it did not get", () => {
  const carried = (gaps: MachineCheckpoint["unreadableFilesystems"]) =>
    ({ unreadableFilesystems: gaps }) as MachineCheckpoint;

  it("says nothing when every mount arrived", () => {
    expect(describeCheckpointMountGaps(carried([]))).toBeNull();
  });

  it("names each mount the sender could not read, with its reason", () => {
    expect(
      describeCheckpointMountGaps(
        carried([{ mountPoint: "/tmp", reason: "a host directory" }]),
      ),
    ).toBe("this machine was restored without /tmp (a host directory)");
  });

  it("names a carried mount this host had nowhere to put", () => {
    expect(describeCheckpointMountGaps(carried([]), ["/srv"])).toBe(
      "this machine was restored without /srv "
      + "(this host has no memory-backed mount there)",
    );
  });

  it("reports both directions in one line", () => {
    expect(
      describeCheckpointMountGaps(
        carried([{ mountPoint: "/tmp", reason: "a host directory" }]),
        ["/srv"],
      ),
    ).toBe(
      "this machine was restored without /tmp (a host directory), "
      + "/srv (this host has no memory-backed mount there)",
    );
  });
});

describe("what a restore does with a handed-over checkpoint", () => {
  it(
    "transfers the checkpoint's buffers to the worker instead of cloning them",
    { timeout: 120_000 },
    async () => {
      // A replica boots from a checkpoint another computer sent it, and that
      // checkpoint is restored exactly once. Handing over ownership must move
      // the buffers — a clone of a large machine is an allocation the runtime
      // can refuse — and the machine adopted from moved buffers must be whole.
      const checkpoint = await captureRealCheckpoint();
      const memories = checkpoint.processes.map((bucket) => bucket.memory);
      const mounts = checkpoint.filesystems.map((mount) => mount.bytes);
      expect(checkpoint.kernelMemory.byteLength).toBeGreaterThan(0);
      expect(memories.length).toBeGreaterThan(0);

      const replica = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        takeRestoreCheckpointOwnership: true,
      });
      await replica.init();
      try {
        expect(checkpoint.kernelMemory.byteLength).toBe(0);
        for (const memory of memories) expect(memory.byteLength).toBe(0);
        for (const bytes of mounts) expect(bytes.byteLength).toBe(0);

        const second = await replica.captureCheckpoint(TIMEOUTS);
        expect(second.status).toBe("captured");
      } finally {
        await replica.destroy();
      }
    },
  );
});
