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
  owns. Every reading also carries the process it was handed to, and a
  replica serves each process its own readings. Syscall order is the
  item above this one and is not in the log yet, so a machine with more
  than one process reads its clocks in an order the two computers never
  share; without the reader's identity such a machine diverges on its
  first reading. Threads of one process share one stream and can still
  diverge, which needs the current thread id at the syscall the same way
  this needed the current process.
- **Accept selection.** Which process took each connection off a shared
  accept queue. A pre-fork server — nginx, php-fpm — leaves every worker
  blocked in `accept` on one queue, and the connection goes to whichever
  worker the host runs first. That choice is nowhere in the machine's
  memory. It is one narrow, tractable case of the syscall-order item
  above, and it is the one that decides which worker's heap serves a
  request, so it is in the log: `kind: "accept"`, keyed by the listener's
  accept readiness token, carrying the winning pid. The kernel asks the
  host at the queue in `sys_accept`; a replaying host tells every other
  worker `EAGAIN` and leaves the connection for the recorded one.
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
| Log transport | `replication/log-local.ts` | Carries the join and the log |
| Log into a replica | `replication/log-queue.ts` | Shared ring a parked replica waits on |
| Link | `apps/browser-demos/lib/peer-link.ts` | Moves to `web-libs/kandelo-session` |
| Roles | `apps/browser-demos/pages/kandelo/app/machine-replication.ts` | User publishes, viewer replicates |
| Screen | `migration/mirror-local.ts` | Fallback mode only |
| Ownership | `migration/transport-local.ts` | Becomes primary election |
| Dispatch order | host scheduling | Logical clock in the kernel worker |
| Clock, random, host I/O | host adapters | Log-sourced |

The log has a wire. `LocalReplicationLog` (`host/src/replication/log-local.ts`)
publishes a running `ReplicationLogRecorder` and delivers its entries to a
peer's sink, in order and without a hole, over the same
`MessageChannelLike` contract the migration transports speak. A peer that
joins after the recording started is sent the backlog, which is what the
boot-and-replay join needs. The peer link opens a fourth data channel,
`kandelo-replication-log`, and gives it the handover's deep-queue defaults
rather than the mirror's shallow ones: a mirror frame may be skipped, a
decision may not.

Both ends are driven by `useMachineReplication`
(`apps/browser-demos/pages/kandelo/app/machine-replication.ts`), which starts
as soon as the peer link opens and needs nothing pressed: the computer holding
a machine serves, the computer holding none joins. A viewer holds a machine
while it replicates and is still the viewer — it announces `holding: false` on
the handover channel, so take-over goes on meaning the user's machine, and a
take-over swaps the two roles with replication starting again the other way
round. `apps/browser-demos/test/kandelo-machine-replication.spec.ts` covers
both directions.

A join that is refused is retried rather than reported as final. Most refusals
name a condition that passes: a machine is read by freezing it, and a process
that makes no syscall reaches no freeze hook, so a shell sitting at a prompt
refuses to be read until something wakes it. The failure stays visible in the
network popup while the viewer keeps asking.

### What a replica does when it drains the log

**Decided and built on 2026-08-29.** A live replica runs the machine at its own
speed, so it reaches the end of what the primary has recorded whenever it gets
ahead. It stops there and waits.

Waiting is not free to arrange. The guest read that drains the log is
`clock_gettime`, which reaches `ReplayingTimeProvider` synchronously inside the
kernel worker: there is no point in that path at which a promise can be awaited
or a `message` event delivered. So the entries cannot arrive by `postMessage` —
a worker parked in `Atomics.wait` does not run its message handler — and they
travel through shared memory instead.

`host/src/replication/log-queue.ts` is that ring. The thread holding the wire
writes framed entries into a `SharedArrayBuffer` and never blocks, because in
both hosts that thread is the main one. The kernel worker blocks on
`Atomics.wait` until an entry is readable, which is the same primitive
`fork-replay-gate.ts` and `checkpoint-freeze-gate.ts` use for the same reason.
Nothing is dropped: entries a full ring cannot take stay with the writer until
the reader makes room, so congestion costs delay and never a decision.

Three consequences worth naming.

**A parked replica serves nothing.** While the kernel worker waits, it answers
no host request either — a spawn, a checkpoint, an `enumProcs`. That is correct
rather than incidental: the machine has not advanced, so there is nothing new
to answer with. It does mean a primary that stops recording without saying so
leaves a replica that looks hung, which is why `end()` on the writer is part of
the protocol and not a courtesy.

**The primary keeps no log.** `ReplicationLogRecorder` retains what it records,
because a replica joins at boot and needs sequence 0. A recorder built with
`retain: false` — which `streamReplicationLog` on both hosts does — keeps
nothing and hands each decision to the main thread as it is made, so the
publisher is the single holder of a log that grows for as long as the machine
runs.

**The end of the log is not divergence.** A replica that reaches the end of a
recording that has ended has finished its replay. It still refuses to read its
own clock there, and says which of the two happened:
`ReplicationLogReader.takeClock` names either "past the end of the log" or
"after the primary stopped recording".

Measured by `host/test/replication/live-join.test.ts`: a replica restored from
the primary's checkpoint is asked to run the guest before the primary has
recorded anything, does not finish, and then completes and prints the primary's
seconds once the primary runs. `host/test/replication/log-queue.test.ts` holds
the ring's own claims, with the reader on a real second thread.

### What clock a replica measures a guest's wait against

**Decided and built on 2026-09-05.** The log's, not this computer's. A guest's
timeout — `poll`, `select`, `epoll_wait`, `nanosleep` — is a duration on the
machine's clock, and on a replica the machine's clock is the primary's log. A
replica that measured it against `Date.now()` serves the wait again at its
original pace, so it never closes the gap it joined with.

This was measured, not reasoned. A viewer following a WordPress machine showed
the sharer's click 22 seconds late. The trace named the cause exactly: the
replica consumed **three log entries per second** for thirteen seconds while
three thousand entries sat unread in its ring. Those three were one
supervisor's readings of `CLOCK_MONOTONIC`. The process spent each second
parked in `epoll_wait(fds, 1000)`, on a deadline this host set from its own
clock, and the injected request the viewer was waiting for sat in the log
behind those readings. Nothing else was implicated: no wait in
`ReplicationLogReader` ever ran, `borrowedClockReadings` stayed at zero, and
the kernel worker never blocked for more than 400 ms.

`ReplicationLogReader.aheadMs(pid)` is the answer, and the shape of it matters.
It reports how much machine time passed between the reading a process was last
served and its **own** next recorded one. The primary spent the wait and then
read the clock on the far side of it, so that gap is the wait the primary
actually served. A wait no longer than the gap is one the primary already
spent, and the host completes it at once.

Two coarser rules were built first and both are wrong, so neither should be
tried again:

- **Gating on the log head** (`entryReady`). The log grows the whole time a
  machine runs, so the head is ahead of an idle process at every moment,
  including when that process is at the head of its own stream. Every wait
  collapses, the process spins, it spends readings the primary has not made,
  and it borrows. Measured: `borrowedClockReadings` climbed to 41 and the
  replica stopped serving pages at all.
- **Gating on "this process has an unserved reading"**. True right up to the
  last one recorded, so a spinning process runs off the end of its own stream
  and borrows the same way. It cut the follow lag from 22 s to 7 s and then
  wedged the machine on the second navigation.

The duration is what makes the rule safe. A wait longer than the gap is one the
primary had not finished, so the replica keeps waiting; the readiness check
itself is untouched, and the wait still ends on whatever the kernel reports.

Zero names the machine rather than a process, for a host wait that belongs to
no guest — the audio backlog discard and the vblank pump — and answers whether
the log carries anything this replica has not reached.

`getReadinessDeadline` in `kernel-worker.ts` is the one place every timed
readiness wait passes through, so the rule is stated once and covers `poll`,
`ppoll`, `select`, `pselect`, `epoll_wait` and `epoll_pwait`; `handleSleepDelay`
states it again for the sleep family. Measured end to end by
`apps/browser-demos/test/repro-wp-sharer-click.spec.ts`: the follow lag went
from 22.0 s to 0.15-2.0 s on the first navigation and under 150 ms after it,
with `borrowedClockReadings` and `borrowedAcceptSelections` both zero.

### How a replica joins a machine that is already running

**Decided on 2026-08-29: by checkpoint, not by boot.** A replica adopts the
primary's `MachineCheckpoint` over the migration transport that already
carries one, then follows the log from there. Boot-and-replay stays the answer
for a modeset guest that has taken GL ownership, whose pixels a checkpoint
cannot read, and that case remains a reported gap rather than a second path.

Joining this way needs the state and the log to meet at one instant. A caller
that captured and then started recording would leave every decision the machine
made between the read and the resume in neither: not in the state the replica
adopts, and not in the log it replays. On a machine with a guest running, that
is not a narrow window.

So the two are one operation. `CheckpointFreezeOptions.onRead` runs inside the
freeze, after `readMachine` and before anything resumes, and
`captureAndStreamReplicationLog` on both hosts is what a caller uses. A capture
that cannot start the log fails as a capture: handing back a checkpoint whose
log never started would give a replica a state to adopt and no decisions to
follow it with. Covered by `host/test/migration/checkpoint.test.ts`, which
asserts the hook sees a parked machine with dispatch still held.

The replica's side of that instant is symmetric, and it is not
`startReplicationReplay`. A restored process resumes inside `init` — the worker
entries relaunch it before they answer — so a replay installed once `init`
returns is installed after that process has already read this computer's clock.
The replay therefore travels on the init message as `replicationReplay`
(`ReplicationReplaySpec` in `host/src/replication/worker.ts`), and both worker
entries install it between the machine's own setup and the first restored
process. `startReplicationReplay` remains the way to put a machine this host
booted fresh onto a log. `host/test/replication/live-join.test.ts` covers the
difference with a guest captured mid-loop: without the init-time install, the
replica's readings drift from the primary's within a second.

A replica lasts exactly as long as the machine it copies, and letting go of it
is part of the contract rather than cleanup. The user launches another demo,
which destroys the machine the replica copies and boots a different one from
sequence 0; the recording ends, and `LocalReplicationLog` says so. A replica
kept past that point is worse than a stopped one: `ReplicationLogReader`
throws `ReplicationDivergence` at the next guest clock read, `kernel.ts`'s
`#hostClockGettime` turns any throw into `-EIO`, the guest dies, `init` starts
a fresh one, and what is left is a second machine wearing the first one's name
on a computer that calls itself the viewer. So `KernelHost.stopReplicatingMachine`
drops the machine to `idle` with the replay, and the viewer is a viewer again —
which is also what sends it to join whatever the other computer is running now.
`host/test/replication/log-local.test.ts` covers the wire, and
`apps/browser-demos/test/kandelo-machine-replication.spec.ts` covers the
product: a viewer running a replicated shell ends up running the fbDOOM the
user launched next.

Input follows the machine for the same reason. A keystroke on a replica is a
decision its primary's log does not carry, so `LiveKernelHost` refuses local
input while it holds one — PTY writes, PTY resizes, framebuffer input, and
mouse events alike. A resize is refused because it is a decision too: it
delivers `SIGWINCH` and a new `TIOCGWINSZ`, and a program that redraws on it
takes a turn the primary's program never took. The viewer's screen stays live;
the keyboard arrives with the take-over.

The primary's side of the same rule is that its input is part of the log.
Both kernel worker entries record a `pty_write` as an `input` decision and a
`pty_resize` as a `resize` decision, named by the PTY's `/dev/pts/N` path
(`ptsDevicePath` in `host/src/replication/log.ts`), and replay them into the
same PTY master — the index is kernel state, so the checkpoint restored it.
Without this the primary's shell runs commands its replica never sees, and
what the viewer holds is a frozen transcript wearing a live machine's name.

A pushed decision needs no guest request, so a replica whose guest sits at a
prompt — reading no clock — would never pull it from the queue. The viewer's
page therefore nudges after every batch it queues: `entries` →
`KernelHost.drainReplicationReplay` → the kernel worker's
`replication_replay_drain`, which takes what the ring already holds
(`takeReady`, never blocking) and applies it. A guest that is parked inside a
clock read needs no nudge; the blocking extender drains as entries arrive.

A live join also softens the clock stream, in two bounded ways, because the
two computers schedule their workers differently and a worker pool hands the
same request to different processes on each of them. Both live in
`ReplicationLogReader.takeClock` (`host/src/replication/log.ts`), both exist
only while a bounded extender is installed, and a finished recording replayed
locally keeps the strict order and the hard `ReplicationDivergence`.

**A process whose counterpart stopped reading borrows.** Readings are served
per process, so a replica process whose primary counterpart never reads the
clock again has no next reading to wait for — and the wait runs on the kernel
worker, which holds every process of the machine, silently. `takeClock`
therefore waits a bounded time (`CLOCK_STREAM_WAIT_MS`, shortened once a
process has borrowed) and then serves the machine-latest reading of that
clock. The reading is still one the primary observed — the log stays the
whole machine's clock — and it cannot step a monotonic clock backward,
because entries append in recorded order. Every borrow is counted in
`borrowedClockReadings` and surfaces in replay progress: a visible softening,
not a silent one.

**A process that interleaves its own clocks differently is served ahead.**
The same scheduling difference reaches inside one process: a replica's
process can read `CLOCK_REALTIME` and `CLOCK_MONOTONIC` in a different
interleaving than its counterpart did, so its next recorded reading is of the
wrong clock. Instead of diverging, `takeClock` scans ahead
(`#findClockAhead`) for the process's next unserved reading of the clock it
asked for, serves it out of order, and leaves the stepped-over reading where
the process's own later read will find it. Every reading served this way is
still one the primary recorded for this process, in order per clock. Only
when no such reading exists does the read fall into the bounded wait and the
borrow above.

Nothing drains the recorder, and that is now deliberate rather than deferred.
A replica joins at boot, so the entries from sequence 0 are the ones it needs
most. The recorder growing without bound at the roughly 184 entries per second
measured in the browser is therefore a real cost to budget, not a leak to
close by forgetting the early log.

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
  now also carries KMS state, as `CheckpointKmsState`
  (`host/src/migration/checkpoint.ts:107`), populated at
  `checkpoint.ts:560`. GBM buffer contents travel too:
  `GbmBoRegistry.snapshot` (`host/src/dri/registry.ts:334`) flushes each
  buffer object out of process memory and copies its pixels, and both
  worker entries wire that into `kmsState`.

Making modeset shareable therefore needs three pieces of platform work.
The first was decided against; the other two are done:

1. **A KMS scanout stream.** Read the frame back where the guest
   finishes it — at the EGL swap in the kernel worker — and publish
   those bytes the way a write-based `/dev/fb0` binding publishes its
   writes. A 1920x1080 BGRA frame is 8.3 MB, so the readback must be
   throttled and it will cost GPU time. This makes modeset mirrorable.
   **Decided against on 2026-08-25.** It is pixel streaming, which mho
   rejected for the reason recorded in Goals: two distant computers
   make it flicker. Under replication a viewer runs modeset in its own
   replica and paints its own canvas, so no frame crosses the network.
2. **KMS state in the checkpoint.** Add the CRTC, the framebuffer
   objects and the GBM buffer contents to `MachineCheckpoint` and to
   the restore path. This makes modeset handoverable, and it is also
   what a replica needs to join. All three are done.
3. **Refuse on real GL ownership, not on a declared mode.** Done.
   `captureMachineCheckpoint` refuses whenever `glOwnedCrtcs()` names a
   CRTC, and `glOwnedCrtcs` used to report every CRTC whose
   `kmsContextMode` was `"webgl2"`. `attachKmsCanvas` sets that mode the
   moment a caller asks for it, before the guest has run any GL, and
   `KernelHost.attachKmsDisplay` defaults to `{ mode: "webgl2" }`, which
   the Modeset pane takes. So a modeset guest that paints by CPU into a
   GBM buffer object — whose pixels the checkpoint does carry — was
   refused for a reason that was not true of it.

   The two facts are now separate. `kmsContextMode` says what may paint
   a CRTC's canvas and still stops the vblank pump from claiming 2D.
   `kmsGlOwned` says what has painted it, and only
   `markKmsCanvasGlOwned` writes it. `host_gl_create_context` calls that
   once `getContext("webgl2")` has returned a context, rather than when
   it merely found a canvas to attach. `glOwnedCrtcs` reads the second
   set, so a checkpoint is refused exactly when the pixels are somewhere
   it cannot read. Covered by `host/test/dri-kms-gl-ownership.test.ts`.

None is a shim over the others: mirroring shows a modeset machine to
someone, handover moves it to them, and replication needs the second and
the third.

### How a replica joins a GL machine

**Decided on 2026-08-27: a replica joins at boot and replays from
sequence 0.** Both peers run their own modeset from the start, so each
builds its own GPU state by executing the same commands. No texture
crosses the network and no frame is read back.

The alternative was to carry GPU state in the checkpoint, which needs a
readback of every texture. That is the pixel readback rejected on
2026-08-25 and it stays rejected.

The choice rests on an assumption that is now measured on the CPU side:
replaying the same commands produces the same machine. Two replicas of a
shell guest that replay one log reach byte-identical kernel memory and
identical filesystems — see "What the instrument says today".

The GPU side stays unproven and is a known boundary, not a claim. Two
peers on different GPUs run different drivers and can round shader
arithmetic differently, so their screens can drift. mho has accepted a
viewer's screen differing by a few pixels. What this does not yet have
is a divergence signal for the GPU: the state hash covers kernel,
filesystems and process memory, and nothing it hashes can see a drifted
texture.

Two consequences for the rest of the path. A viewer cannot join a
modeset machine that is already running — joining means booting the same
machine, so the log must start at sequence 0 and be retained from there.
And `ReplicationLogRecorder` retaining every entry stops being only a
leak and becomes a requirement for the GL case, which changes what
"drain the log when streaming lands" can mean.

### How a viewer follows the web preview

The web preview is a fourth surface, and it is neither pixels nor a
PTY: it is HTTP. The primary's page routes every `/app/` request
through the service worker to the bridge, and the bridge injects it
into the machine as a synthetic connection. An injection is host
input — the accept, the randomly drawn peer port, and the request
bytes are all host-produced — so it enters the log as
`ReplicationHttpExchange` (`host/src/replication/log.ts`). The
response does not travel: it is the machine's own output, and a
replica that runs the same machine computes it again.

A viewer's page asks for the same resources, and its machine must not
see those asks — a live injection on a replica is an input the
primary's log does not carry, and it diverges the machine. The
pairing happens outside the machine instead (`ReplayedHttpExchanges`
in `host/src/replication/worker.ts`): each replayed exchange deposits
the response this replica computed, keyed by request line, and the
viewer's fetch takes the copy. Latest wins per request line, because
the two browsers cache differently.

That cache difference is also the surface's open hole. What the
primary's browser never asks for, the primary's machine never serves.
WordPress marks its static assets cacheable, so a font or script that
loaded once comes from the primary's HTTP cache afterward; no
injection happens, nothing enters the log, and the viewer's identical
request waits out its park and reports "unrecorded" — a 502 whose
cause is a cache asymmetry between two browsers, not a divergence.

The cache hole has a sibling: the late joiner. A checkpoint joiner
follows the log from the join instant; an exchange served before that
instant is in the state it adopted, not in the entries it replays, so
its response never lands in the viewer's store — and re-injecting it
on the replica would make that machine serve a request the primary's
machine never served again. The publisher reloading its preview when
recording starts (`previewReloadToken`) narrows this to what the
reload's own cache hits swallow, which is the same hole again.

**Built 2026-09-04: a viewer's miss becomes the primary's request.**
When a viewer's fetch finds no replay of its
request line coming, it does not give up and does not inject. It
forwards the request line over the peer link to the primary's page,
and that page fetches it through its own service worker with `cache:
"no-store"` — past its browser cache, into its bridge, into the
machine. The injection is a primary input like any other: it enters
the log, every replica replays it, and the replica's own computed
response resolves the viewer's parked fetch through the
`expect`/`deliver` pairing that already exists. Both holes close at
once. No response bytes cross the wire, the checkpoint does not grow,
and the primary's browser keeps its cache — the blanket
`Cache-Control: no-store` header considered first is not needed,
because the one fetch that must skip the cache says so itself.

The boundaries of the mechanism:

- Only GET and HEAD forward. Any other method is a mutation, and the
  viewer that cannot type cannot POST either; those stay refused.
- The viewer forwards after a short park, not after the full 30 s
  deadline `ReplayedHttpExchanges.take` waits today — "unrecorded" is
  only knowable by waiting, and a viewer that waited the full
  deadline before asking would read as a broken page. A forward that
  races a replay already in flight costs one redundant injection, and
  latest-wins absorbs it.
- The viewer dedups misses per request line while one is in flight,
  so a page asking for the same font four ways costs the primary one
  injection, not four.
- A forwarded GET still runs guest code — nginx logs it, PHP may
  touch a session — which is true of every request the primary's own
  page makes. The viewer sees the machine as the primary's browser,
  cookie jar included; that is what viewing one session means.
- A primary that is gone cannot serve, and the miss stays "never
  served" — which is then true.

The alternative, kept as the fallback: the primary retains the latest
response per request line and ships that store with the checkpoint,
pre-seeding the viewer's `ReplayedHttpExchanges`. It answers misses
with no round trip, but it grows the join payload by a page's worth
of assets and it puts recomputable machine output on the wire — the
data the log's whole design keeps off it. It becomes worth building
only if miss-forwarding's round trip reads as a broken page in
practice.

Forwarding delivered the request and then exposed what was behind it.
The viewer's WordPress replica served the same injected request as a
500 while the primary served it 200, with no divergence raised and a
clean log replay — uncaptured nondeterminism rather than a log fault.
Its cause was accept selection. The demo runs php-fpm with
`pm.max_children = 6`, all six workers blocked on one shared accept
queue, and the connection went to whichever worker each host ran
first; the replica handed the request to a worker whose own heap
fatalled on it. A single-worker ablation rendered byte-identical on
home, `?p=1` and wp-login, which named the cause. The fix is the
`kind: "accept"` decision described under "What must enter the log":
all six workers stay, and each one does what its counterpart did.

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
6. Put KMS state in the checkpoint so a modeset machine can be handed
   over. The scanout-stream half of this step was dropped on
   2026-08-25: see the decision recorded above.
7. Make the guest clock log-sourced. Deterministic time is the single
   largest source of divergence and is useful alone: it makes replay
   debugging possible. Done, at the one interface every guest clock
   read already crosses (`TimeProvider`). A machine records with
   `RecordingTimeProvider` and replays with `ReplayingTimeProvider`
   (`host/src/replication/clock.ts`); both hosts drive them from their
   kernel-worker entry, and `NodeKernelHost` exposes the four calls
   `startReplicationRecording`, `stopReplicationRecording`,
   `startReplicationReplay` and `stopReplicationReplay`. Measured: a
   replica restored from a checkpoint and fed the log prints the
   recorded timestamps, not its own.

   The clock is the machine's, not the guest's. SharedFS stamped inode
   atime, mtime and ctime from `Date.now()`, which is why the first
   measurement still showed `filesystem:/` diverging under replay.
   Those stamps now cross the same provider: `SharedFS.setClock`
   replaces the wall clock a filesystem writes from,
   `MemoryFileSystem.setTimeProvider` converts a provider reading to
   the milliseconds the inode fields hold, and `VirtualPlatformIO`
   hands its clock to every mount that keeps its own file times.
   Measured: two replicas replaying one log now agree on
   `filesystem:/`, and two replicas on their own clocks still do not.
8. Make randomness log-sourced.
9. Add state hashing at fixed log positions, and a divergence report.
   Build this before the machine is deterministic — it is the
   instrument that tells you how far from deterministic it is. Done,
   and it has produced its first measurement. See "What the instrument
   says today" below.
10. Give the kernel worker a logical dispatch clock, and make
    single-process single-threaded guests deterministic. Prove it with
    a record-and-replay conformance suite. The dispatch clock is not
    yet justified: byte-diffing two replicas showed the kernel already
    reproduces for a single-process single-threaded guest, and located
    the only remaining difference in dead call-stack scratch. Build the
    conformance suite first and let it say whether a logical clock is
    needed. See "What the instrument says today".
11. Route external I/O through the log, primary-authoritative.
12. Replicate a live machine end to end for a single-process guest,
    with resync-on-divergence.
13. Extend to multi-process and pthread guests, or document the
    boundary if the cost is not worth paying.

## What the instrument says today

Measured on 2026-08-27 with `host/test/replication/replay-determinism.test.ts`.
The machine is a Node Kandelo booted from the default rootfs image. The guest
is `sh -c` running `date +%s` five times: five guest clock reads, no
randomness, no external bytes. Every replica adopts one checkpoint of the same
idle machine.

| Comparison | Regions that differ |
|---|---|
| Two replicas that run nothing | none |
| Two replicas replaying one log | none, or `kernel` by a few dead stack bytes |
| Two replicas reading their own clocks | `kernel`, `filesystem:/` |

Five things follow.

**The log-sourced clock works.** A replica prints the recorded seconds, not the
seconds its own host would have read. The test waits two seconds before the
replay so a match cannot be two runs landing in the same second.

**The log removes the `filesystem:/` divergence.** Inode atime, mtime and
ctime now cross the machine's `TimeProvider` rather than `Date.now()`, so two
replicas replaying one log write identical file metadata. Two replicas reading
their own clocks still diverge there, which is what says the log is why the
first pair agrees rather than luck.

**The kernel reproduces too, and dispatch order is not the cause.** This was
step 10's suspicion and the measurement does not support it. Byte-diffing the
two 14 MB `kernelMemory` regions over thirteen replayed pairs: twelve were
identical byte for byte, and the one that was not differed by three bytes at
`0xffffc`.

That address names the cause. The kernel Wasm is linked stack-first with
`global[0]`, its `__stack_pointer`, starting at `0x100000`; `__data_end` is
`0x116acc`. So `[0, 0x100000)` is call-stack scratch and the data segment and
heap sit above it. `0xffffc` is four bytes below the stack top — residue from a
call that had already returned, not state a replica must reproduce. The region
hash reports it because it covers the whole linear memory. Every divergence
measured under replay, and every one measured on live clocks, was below that
line; none was in the data segment or the heap.

The same byte-diff locates the live-clock divergence exactly: two replicas on
their own clocks differ at `0xefcb8`, which holds a `timespec` whose seconds
field reads as the wall-clock second of the run. Replicas fed the log hold the
same bytes there.

**The log is the whole machine's clock, not the guest's.** Recording the
five-`date` guest yields nine entries: the guest's five reads plus the
filesystem's four inode stamps. A replica asks for exactly nine, which is
itself a determinism check — a shortfall or an overrun would mean the two runs
took different paths. A guest transcript is therefore a subsequence of the
logged readings, not the whole of it.

**A region hash over raw linear memory is coarser than the machine.** It calls
dead stack scratch a divergence. Deciding a byte is dead needs the stack
pointer, which the checkpoint does not carry today, so the test bounds the
difference by the stack line rather than asserting a byte count. This is the
next thing to settle about the instrument, and it is a question about the hash,
not about the machine.

This measurement is for one guest: a single-process, single-threaded shell that
reads the clock and nothing else. It says dispatch order does not diverge that
workload. It does not say the kernel is deterministic, which is what step 10's
conformance suite is for.

## What a checkpoint carries across its mounts

**Decided on 2026-08-27, built on 2026-08-27.** A checkpoint asks every
mount for its bytes and carries every mount that can answer. A mount
that cannot — a Node `HostFileSystem` backed by a real directory —
refuses, and the refusal is recorded in the checkpoint so a restore
reports what it did not get.

Before this, both worker entries built `checkpointMounts` by filtering
`specMounts` to `MemoryFileSystem`. The two hosts then disagreed about
what a machine is, because their mount topologies differ rather than
their code: in the browser every mount is a `MemoryFileSystem`, while on
Node every mount except `/` is a `HostFileSystem` under the per-boot
session directory (`host/src/vfs/default-mounts-node.ts:96`). So a Node
checkpoint carried `/` alone and said nothing about the rest.

Carrying nothing is defensible for a host directory. Saying nothing
about it is not: a restore presents a machine missing `/tmp` as if it
were whole, which is the convenient illusion the platform values
contract forbids.

### How it is built

`FileSystemBackend.checkpointBytes()` is the question, and it is
optional: a backend that does not implement it is recorded as unreadable
rather than dropped. `MemoryFileSystem` answers with its
SharedArrayBuffer. `HostFileSystem` refuses, naming the backing kind and
not the sandbox path — a checkpoint travels to another computer, and the
path is this computer's business.

`askMountsForCheckpointBytes` (`host/src/migration/checkpoint.ts`) asks
the list, and both worker entries build `filesystemBuffers` from it, so
one code path decides what a machine is on both hosts. The mounts asked
are `specMounts` alone. `/dev` and `/dev/shm` are device surfaces the
host provides and a restore rebuilds, so they are not machine state to
hand away and never appear as gaps.

`MachineCheckpoint.unreadableFilesystems` carries the refusals, and
`MachineCheckpointSummary` repeats them so a caller holding no bytes
still sees them. The layout version `MACHINE_CHECKPOINT_FORMAT` went
from 3 to 4; a restore refuses format 3 outright rather than guessing at
the missing field. The checkpoint is not part of the kernel ABI, so
`ABI_VERSION` did not move.

A restore reports the gap through `describeCheckpointMountGaps`
(`host/src/migration/restore.ts`), which both entries send to
`reportHostDiagnostic` at `warn`. It reports two directions: mounts the
sender could not read, and mounts the sender carried that this receiver
has nowhere memory-backed to put. A gap never refuses the checkpoint — a
machine short `/tmp` is still worth moving — but it is never silent.

Today a Node checkpoint records seven gaps (`/tmp`, `/var/tmp`,
`/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`) and a browser
checkpoint records none. The asymmetry is now visible in the artifact
rather than implied by the host it came from.

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
