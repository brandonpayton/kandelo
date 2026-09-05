# State Machine Replication Design

Kandelo shares a running machine today by streaming its screen. This
document records the decision to replace that primitive: a shared
Kandelo machine should be replicated, not filmed. Two computers should
run the same machine from the same state, driven by the same ordered
log of everything that can change it, and each should render locally.

Nothing in this document is implemented. The pieces that exist today —
`host/src/migration/` (checkpoint, restore, chunked network channel,
framebuffer mirror, handover) and `apps/browser-demos/lib/peer-link.ts`
(manually signalled WebRTC) — are the transport and the state-transfer
half. What is missing is the deterministic machine that would let a
second computer keep in step without being sent pixels.

## The decision

Replication is the target model for sharing a live Kandelo machine.
Screen streaming stays only where replication cannot apply, and is
treated as a fallback for spectating, not as the way two people share a
computer.

The decision is recorded now, before more syscall and host surface is
built, because determinism is not a feature that can be added at the
end. It is a constraint on every syscall, every host adapter, and every
scheduling decision. Adding it later means auditing all of them.

## The evidence that motivated it

Measured on a real fbDOOM machine on 2026-08-23, captured through
`NodeKernelHost.captureCheckpointBytes`:

| What | Bytes |
|---|---:|
| Kernel memory | 19,136,512 |
| Filesystem image | 16,777,216 |
| fbDOOM process memory | 18,219,008 |
| Framebuffer, 640x400 BGRA32 | 1,024,000 |
| Whole checkpoint, codec-encoded | 56,092,857 |

fbDOOM writes its whole framebuffer once per tic. At 35 tics per second
the mirror publisher offers 35 MB/s — 286 Mbit/s — to the wire. No
consumer network carries that, so the publisher must drop most frames
whatever else is true.

Deflate, added to `ChunkedMessageChannel` on the same day, reduces the
traffic by roughly 15x (checkpoint 56,092,857 to 3,649,665 bytes; one
frame message 1,024,088 to 61,317). That made a two-computer demo work
on a local network. It does not make screen streaming the right answer
over a long link: a stream is still lossy, still blurry under loss, and
still costs bandwidth proportional to screen area and frame rate rather
than to what the user did.

Replication inverts that. Traffic becomes proportional to events, the
far screen is rendered locally and therefore sharp, and text stays
legible at any distance.

## Goals

- Two or more computers run one logical Kandelo machine, each holding a
  full local copy of its state.
- What crosses the network is the machine's input log, not its output
  pixels.
- Every replica renders locally, so text and graphics are exact rather
  than reconstructed.
- Divergence is detected, reported, and repaired, never silently
  tolerated.
- A replica that cannot keep up degrades to a documented boundary
  instead of drifting.

## Non-goals

- Simultaneous consistency. Replicas are separated by network delay and
  always will be. The goal is exactness, not simultaneity.
- Replacing the framebuffer mirror. Spectating a machine you cannot or
  should not run stays a legitimate mode with different trade-offs.
- Multiplayer for a specific program. A guest with its own network
  protocol — fbDOOM's netgame is the example — is better served by
  connecting two Kandelo machines with a socket and letting the guest
  synchronise itself. That needs no determinism and is a separate,
  smaller piece of work.

## Core model: replicate the kernel's decision log

Most systems that want replication must first invent a serialisation
point. Kandelo already has one. Every effect a guest can have crosses
the syscall channel, and one kernel worker serves every process on the
machine. That single ordered stream is the natural log.

So the unit of replication is not the application's keyboard and mouse.
It is the kernel's decision log: the ordered sequence of syscalls and
of the values the host returned for them.

```text
replica state(n) = f(replica state(n-1), log entry n)
```

If `f` is deterministic and both replicas start from the same state and
consume the same log, they are the same machine. The existing
`MachineCheckpoint` is exactly "the same state": a replica joins by
restoring a checkpoint, then follows the log from the sequence number
that checkpoint was taken at.

One replica is the primary. It decides the order of the log and the
value of every nondeterministic result. Every other replica is a
secondary that applies the log and originates nothing on its own.
Secondaries send their user input to the primary as proposals; the
primary places them in the log and that placement is what makes them
real.

## What must enter the log

Everything a guest can observe that is not already a function of its
own memory:

- **Syscall order.** Which process's syscall the kernel served, and in
  what order. Today that follows the host OS's scheduling of the
  process workers, which differs on every machine.
- **Time.** Every `clock_gettime`, `gettimeofday` and `times` result.
  The guest clock becomes a value the log carries, not a value the host
  reads. `MachineCheckpoint.monotonicNs` and the monotonic-floor work
  already establish that the guest clock is something the platform
  owns.
- **Randomness.** Every `getrandom` result, or a seed the replicas
  share and a deterministic generator on top of it.
- **External bytes.** Socket reads, lazy file fetches, OPFS reads,
  anything whose content or timing comes from outside the machine.
- **User input.** Keystrokes, mouse, terminal input, window geometry —
  the events the product thinks of as "sharing", and the smallest part
  of this list.

The log carries decisions, not contents, wherever both replicas already
hold the data. If both booted the same VFS image, a 4 MB file read
replicates as the fact of the read, not as 4 MB. That is what keeps the
log small enough to be worth the trouble.

## What determinism costs

The kernel and host must become a deterministic function of state and
log. Concretely:

- The centralized kernel must dispatch by a logical clock, not by
  arrival time. Two runnable processes must be served in an order the
  log fixes.
- Every host adapter must route its result through the log rather than
  returning it directly.
- pthreads and multi-process guests are where this is hardest. Each
  process is a real worker on a real OS thread today, and a preemptive
  schedule is not reproducible. Single-process, single-threaded guests
  are reachable much sooner than the general case.
- Every future nondeterminism is a bug whose symptom is silent
  divergence on someone else's computer. That raises the cost of every
  change to the syscall surface, permanently.

This is the part of the decision that needs Brandon's agreement, not
just mho's, because it constrains the kernel's design rather than the
demo's.

## Latency and authority

A secondary is always at least one network delay behind the primary.
Nothing changes that. What changes is what arrives: a correct frame
rendered locally rather than a compressed approximation of one.

If only one person drives, the input path is unaffected — the primary
runs at full speed and the secondary trails. If both drive, the
machine cannot advance past step N until every replica's input for step
N is known, so everyone pays the round trip. That is the classic
lockstep trade and it should be a mode, not the default.

## Divergence detection and resync

Silent divergence is the failure mode that makes replication hard to
trust. Every replica must hash its state at fixed log positions and
exchange the hash. A mismatch is a platform defect and must be reported
as one, loudly, naming the log position.

The repair is already built: ship a fresh `MachineCheckpoint` and
restart the secondary from it. That path exists, is tested, and now
costs about 3.5 MB deflated. Kandelo is unusually well placed to
recover from divergence even before it is good at avoiding it.

## Where this lands in the existing code

| Concern | Today | Under replication |
|---|---|---|
| State transfer | `migration/checkpoint.ts`, `restore.ts` | Unchanged; becomes replica join and resync |
| Wire | `migration/channel-chunked.ts` | Unchanged; carries the log |
| Link | `apps/browser-demos/lib/peer-link.ts` | Moves to `web-libs/kandelo-session` |
| Screen | `migration/mirror-local.ts` | Fallback mode only |
| Ownership | `migration/transport-local.ts` | Becomes primary election |
| Dispatch order | host scheduling | Logical clock in the kernel worker |
| Clock, random, host I/O | host adapters | Log-sourced |

`ShareMode` in `web-libs/kandelo-session/src/kernel-host.ts` already
declares `"live"`, and `docs/plans/2026-05-11-shareable-computer-url-design.md`
defines it as "Connect to a collaborative or server-backed state
source". Replication is what that mode means. `"replay"` in the same
list — "start from clean base and replay a command transcript" — is the
same determinism requirement in single-machine form, so the two modes
share the work.

## Surfaces, and what sharing each one needs

The three machine surfaces are not equally shareable, and the reason is
where their pixels live.

**Terminal — shareable today.** Output bytes leave the kernel through
one place, `LiveKernelHost.emitPtyData`, and input enters through
`ptyWrite`. Nothing about it is pixels, so a peer renders locally and
the traffic is proportional to what the machine printed.

**`/dev/fb0` — mirrorable when the guest writes.** A write-based
binding keeps its pixels in a host buffer and publishes every write,
which is what `LocalFramebufferMirror` forwards. An mmap-based binding
has no write stream and `publish` refuses it rather than showing a
stale frame as live.

**`/dev/dri/card0` — not shareable at all today.** The modeset surface
never enters `FramebufferRegistry`, so neither the mirror nor the
checkpoint can see it:

- `LiveKernelHost.attachKmsDisplay` calls
  `canvas.transferControlToOffscreen()` and passes the canvas into the
  kernel worker with `mode: "webgl2"`.
- The guest paints that OffscreenCanvas directly through the EGL to
  WebGL2 bridge. The worker's vblank pump explicitly skips a GL-owned
  canvas, so no CPU ever assembles a frame.
- The only path that does assemble one is `mode: "2d"`, which a GL
  guest cannot use: a 2d context cannot be painted by GL.
- `MachineCheckpoint` carries `/dev/fb0` bindings and their pixels. It
  carries no KMS or GBM state at all, so handing over a modeset machine
  would restore one whose display state is missing.

Making modeset shareable therefore needs one of two pieces of platform
work, and both are real:

1. **A KMS scanout stream.** Read the frame back where the guest
   finishes it — at the EGL swap in the kernel worker — and publish
   those bytes the way a write-based `/dev/fb0` binding publishes its
   writes. A 1920x1080 BGRA frame is 8.3 MB, so the readback must be
   throttled and it will cost GPU time. This makes modeset mirrorable.
2. **KMS state in the checkpoint.** Add the CRTC, the framebuffer
   objects and the GBM buffer contents to `MachineCheckpoint` and to
   the restore path. This makes modeset handoverable, and it is also
   what a replica needs to join.

Neither is a shim over the other: mirroring shows a modeset machine to
someone, handover moves it to them, and replication needs the second.

## Implementation Path

The order is chosen so each step is useful on its own, and so the
expensive determinism work is entered last and with evidence.

1. Replicate terminals. PTY output one way, keystrokes the other. No
   determinism, no pixels, exact text, small traffic. This covers most
   Kandelo demos and is the first thing a colleague at distance should
   get.
2. Move the peer link and both migration transports out of
   `apps/browser-demos/lib/` into `web-libs/kandelo-session`, so any
   machine can be shared rather than one demo page.
3. Put a network option in the product dock, with the manual signalling
   that exists today.
4. Replace the manual paste with a signalling service: a plain Node
   `ws` process exchanging the same two strings.
5. Reduce the framebuffer mirror to changed regions instead of whole
   frames. Still a stream, far smaller, and it makes the fallback mode
   respectable.
6. Give `/dev/dri/card0` a scanout stream read back at the EGL swap, so
   the modeset surface can be mirrored at all, and put KMS state in the
   checkpoint so it can be handed over.
7. Make the guest clock log-sourced. Deterministic time is the single
   largest source of divergence and is useful alone: it makes replay
   debugging possible.
8. Make randomness log-sourced.
9. Add state hashing at fixed log positions, and a divergence report.
   Build this before the machine is deterministic — it is the
   instrument that tells you how far from deterministic it is.
10. Give the kernel worker a logical dispatch clock, and make
    single-process single-threaded guests deterministic. Prove it with
    a record-and-replay conformance suite.
11. Route external I/O through the log, primary-authoritative.
12. Replicate a live machine end to end for a single-process guest,
    with resync-on-divergence.
13. Extend to multi-process and pthread guests, or document the
    boundary if the cost is not worth paying.

## Open Questions

- Should the log be a first-class ABI artifact, versioned like
  `abi/snapshot.json`, or a host-runtime concern outside the ABI?
- Where does primary authority live when the primary's browser tab
  closes: elect a new primary from the log, or end the session?
- Does a secondary run the machine at full speed and buffer ahead, or
  strictly follow the log position the primary has confirmed?
- What is the state hash over: kernel memory and every process memory,
  or a cheaper summary that still catches real divergence?
- Can Asyncify-instrumented fork continuations be made deterministic,
  or does fork stay outside the replicated subset?
- Is a deterministic scheduler compatible with the performance contract
  in `docs/agent-guidance/performance.md`, or does it need an explicit
  exemption when replication is on?
- Should replication and the framebuffer mirror be selectable per
  machine, or should the platform pick based on whether the guest is in
  the deterministic subset?
