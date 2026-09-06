# Browser Support

> **Contributor note — dual-host parity is load-bearing.** The browser host is a peer of the Node.js host, not a follower. Any change touching host-runtime behavior MUST land symmetrically on both hosts, **in the same PR**. See [`CLAUDE.md`](../CLAUDE.md#two-hosts-browser-and-nodejs--dual-host-parity-is-load-bearing) for the hard requirements. PR #388 (brk-base) and PR #410 (worker exit message) both shipped one-sided fixes that left browser behavior broken for users; those are the failure modes this rule exists to prevent.

## Overview

Kandelo runs in modern browsers with SharedArrayBuffer support (Chrome 91+, Firefox 79+, Safari 16.4+). The shared-kernel architecture uses one kernel Wasm instance in a dedicated web worker, with each process running in a sub-worker.

## Required HTTP Headers

SharedArrayBuffer requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, `SharedArrayBuffer` is undefined and the kernel cannot initialize.

## Architecture

The kernel runs in a dedicated web worker, freeing the main thread for UI rendering and coordination only. The main thread uses `BrowserKernel` as a thin proxy that communicates with the kernel worker via `postMessage`.

```
Main Thread (BrowserKernel)              Kernel Worker
├── UI / rendering                       ├── CentralizedKernelWorker
├── Page API (boot, stdin, network)      ├── MemoryFileSystem (kernel-owned)
├── PTY terminal ──pty events──>         ├── Kernel Wasm instance
├── HTTP bridge / TCP injection          ├── Syscall dispatch (Atomics.waitAsync)
├── Local virtual network                ├── POSIX socket routing
├── App clients (MySQL, Redis)           ├── Process lifecycle (fork/exec/clone/exit)
│   └── async pipe ops ────────────────> ├── Process sub-worker creation
│                                        ├── Connection pump (HTTP↔TCP bridge)
│                                        ├── Exec reads binaries from VFS
└──── MessagePort (RPC) ───────────────> └── Blocking retry management
                                                    │
Service Worker ──MessagePort──> Kernel Worker       │
                                                    │
                                   Process Workers ──┘ (SharedArrayBuffer channels)
```

| Component | Location | Purpose |
|-----------|----------|---------|
| `BrowserKernel` | `host/src/browser-kernel-host.ts` | Main-thread proxy that sends messages to the browser kernel worker |
| Browser kernel worker entry | `host/src/browser-kernel-worker-entry.ts` | Hosts CentralizedKernelWorker and owns process lifecycle |
| `CentralizedKernelWorker` | Kernel worker | Kernel instance, handles all syscalls |
| Process Workers | Sub-workers of kernel worker | One per process, communicates via SharedArrayBuffer + Atomics |
| Service Worker | `apps/browser-demos/public/service-worker.js` | Intercepts HTTP for nginx/WordPress demos |
| Connection pump | `host/src/browser-kernel-worker-entry.ts` | Bridges HTTP requests to kernel TCP pipes |

### Key Design Decisions

- **Kernel in dedicated worker**: Browser syscall notification remains event-driven through `Atomics.waitAsync`; it does not poll channels. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue, allowing syscall handling and worker messages to keep progressing together under multi-process bridge load. Node.js keeps its native/default batching unchanged.
- **Kernel-owned VFS** (preferred path, `kernelOwnedFs: true` + `kernel.boot()`): the kernel worker restores a pre-built VFS image and exec()s `argv[0]` as the first user process. The main thread never instantiates a `MemoryFileSystem` and is not in the FS hot path. Service-supervised demos run dinit under the first kernel-allocated user PID (100); PID 1 remains the kernel's synthetic init reservation. Single-program demos exec the language interpreter directly.
  Browser harnesses that must stage a transient file between process spawns use
  `BrowserKernel`'s worker RPC methods (`readFileSnapshotFromVfs`,
  `writeFileToVfs`, and `unlinkFileFromVfs`). The owning worker performs those
  mutations through the mounted VFS; the main thread never receives the live
  VFS `SharedArrayBuffer`.
  A quiescent machine can return durable root-image bytes through
  `BrowserKernel.exportRootfsImage()`. The worker rejects export while a guest
  process or teardown is live, serializes it against the same staging and lazy
  materialization RPCs, and transfers only the `/` image backend. Scratch,
  device, and shared-memory mounts are boot-local and are recreated when those
  bytes start another machine.
- **Legacy shared VFS** (`memfs:` constructor option + `kernel.spawn()`): main thread holds a `MemoryFileSystem` and shares the SAB with the kernel worker. Used by demos that fetch transient binaries at runtime (test runners, REPLs that load arbitrary user code, benchmark suites). The main thread transfers each program's bytes, but the Rust `ProcessTable` allocates the PID and the worker returns it. Top-level creation, guest fork/spawn, and thread clone all draw from that one authoritative task-ID sequence; no browser or host-side allocator exists.
- **Exact module reflection**: each process worker binds a compiled module to
  the exact Wasm bytes that passed artifact admission. Import and export names,
  kinds, and declaration order come from Kandelo's binary contract parser.
  This keeps Node.js, Chromium, Firefox, and WebKit on one path; in particular,
  WebKit can compile ABI 43 exception-reference imports even when its
  `WebAssembly.Module.imports()` API cannot produce descriptors for them.
  Modules created by an external embedder without registered bytes retain the
  native reflection fallback.
- **Signal-wait engine matrix**: the real BrowserKernel worker path runs the
  wasm32 ppoll/pselect interruption matrix and wait4 unknown-option rejection
  on Chromium, Firefox, and WebKit. Chromium and Firefox also run its wasm64
  counterpart. The current Playwright WebKit engine rejects the Memory64
  module at `WebAssembly.validate`, so WebKit's truthful boundary is wasm32
  rather than a skipped or simulated wasm64 success. Browser injection waits
  on guest-published atomic gates in the real process memory, so acceptance
  does not depend on a fixed event-loop delay.
- **Exec reads from filesystem**: Like a real OS, `exec()` reads binaries from the kernel-side `MemoryFileSystem`. Programs are baked into the VFS image at build time (or written by the page in the legacy path before spawning). Symlinks are used for multicall binaries (e.g., coreutils).
- **dinit for service supervision**: Multi-process demos (nginx, redis,
  mariadb, nginx-php, wordpress, lamp, mariadb-test) bake `/sbin/dinit` and
  per-service files under `/etc/dinit.d/` into the VFS image via
  `addDinitInit()` (`images/vfs/scripts/dinit-image-helpers.ts`). dinit is the
  first user process, not PID 1. It reaps its directly supervised children and
  handles `depends-on` ordering and bootstrap-then-daemon chains. Synthetic
  PID 1 has no wait loop, so Kandelo does not yet reap children reparented to
  it. Page code waits for service-ready via `onListenTcp` (port-bind)
  callbacks, then starts driving the demo over kernel-loopback TCP or the HTTP
  bridge. The corresponding Node demo commands resolve and authenticate the
  same VFS artifacts, apply only per-run configuration such as a listen port,
  and start image-owned dinit through `NodeKernelHost.spawnFromVfs()`.
- **Connection pump in kernel worker**: HTTP↔TCP bridge runs inside the kernel worker with synchronous pipe I/O (direct Wasm export calls). Service worker transfers a MessagePort to the kernel worker for HTTP request delivery.
- **App clients on main thread**: MySQL and Redis wire protocol clients stay on the main thread and use async pipe operations via the message protocol.
- **Rust-owned advisory locks**: the browser host does not hold advisory-lock
  records in a `SharedArrayBuffer` or inspect their ranges. The machine-wide
  Rust `ProcessTable` manager is authoritative. When a blocking `F_SETLKW`
  conflicts, the browser worker parks that syscall channel; a Rust advisory-lock
  wake event reschedules parked lock requests after unlock, conversion, close,
  or process teardown. `ENOLCK` completes immediately, and the short retry
  timer is only a scheduling safety net. Descriptors queued through
  `SCM_RIGHTS` retain their Rust `OfdId`, `FileId`, and backing reference, so
  sender close, successful receipt, discard, and receiver-allocation failure
  all use the same final-reference rule without host-side lock inspection.

### ABI 40 host-package migration

ABI 40 removes the kernel's `host_fcntl_lock` import and removes the public
`wasm-posix-host` exports `SharedLockTable` and `LockInfo`, along with
`WasmPosixKernel.registerSharedLockTable()`. This is an intentional breaking
host-package API change, not a deprecation shim. Embedders must stop importing,
constructing, registering, or crash-resetting a shared lock table. The guest
`fcntl`, OFD-lock, and `flock` APIs remain available; all lock state, ownership,
range operations, and the 4096-normalized-record policy now live in the kernel
Wasm.

The host `StatResult.dev` and `StatResult.ino` fields now accept
`number | bigint`, and Node-backed adapters return `bigint` so device and inode
identities cannot lose precision. Embedders that serialize these values or use
number-only arithmetic must handle `bigint` explicitly. The kernel marshalling
contract remains exact unsigned 64-bit values.

### Syscall Flow

```
Process Worker → SharedArrayBuffer channel → Atomics.notify
→ CentralizedKernelWorker.handleChannel() → kernel_handle_channel()
→ result written to channel → Atomics.notify → Process Worker resumes
```

### HTTP Request Flow (nginx/WordPress demos)

```
Browser fetch → Service Worker intercepts
→ MessagePort → BrowserKernel.fetchInKernel() → Kernel Worker
→ kernel_inject_connection() → pipe write (raw HTTP)
→ nginx (Wasm) accepts, processes → pipe read (response)
→ MessagePort → Service Worker → browser Response
```

Injected TCP pipes live in the kernel's global pipe table (`pid == 0` for
`kernel_pipe_*` host calls), so a listener inherited across fork can accept the
connection in any nginx worker. The standalone nginx image runs with
`master_process on` and `worker_processes 2`.

AF_UNIX stream listeners use the same shared-queue ownership model. This is the
path used by pre-fork PHP-FPM workers: a connection is queued once and whichever
worker wins `accept()` materializes its own connected socket around the global
pipe pair.

## Capabilities

### Multi-Process
- `fork()` via `wasm-fork-instrument` snapshot/restore — child runs in new sub-worker with copied memory
- `exec()` reads program binary from the shared filesystem, replaces process
- `posix_spawn()` — non-forking child creation with file actions (addchdir, addfchdir, addclose, adddup2)
- Process groups, wait/waitpid, cross-process signals, pipes

### Threads
- `clone()` with `CLONE_VM|CLONE_THREAD` — shared Memory between parent and thread Workers
- Used by MariaDB (5 threads), Redis (3 background threads)

### Networking
- POSIX AF_INET TCP and UDP inside the kernel, including local loopback and virtual IPv4 machine-to-machine networking
- Partial AF_INET6 streams and datagrams for `::`/`::1`; loopback streams have a cross-process path, while datagrams remain process-local, and neither provides external or virtual-network IPv6
- In-kernel IPv4/IPv6 loopback datagrams, AF_UNIX datagrams, and IPv4 multicast are process-local; machine-wide datagram routing is still pending
- `LocalVirtualNetwork` attaches multiple browser Kandelo machines to virtual IPv4 addresses in one browser session
- Browser networking backends preserve valid decimal one-, two-, three-, and four-component IPv4 forms, reject malformed/overflowing numeric forms, enforce ASCII host-label syntax and DNS length limits, and synthesize IPv4 addresses only for acceptable hostnames; they do not provide AF_INET6 DNS/transport
- The network lab at `/pages/network/` is intended to run GNU Netcat (`nc`)
  and `curl` against those virtual sockets. Its current browser verification is
  deferred by the multi-kernel scheduling limitation documented below; the
  equivalent packaged-netcat virtual-network path remains covered on Node.js.
- Service worker cookie jar for session persistence (WordPress)
- nginx serves static files and proxies to PHP-FPM via loopback TCP

### Filesystem
- `MemoryFileSystem` — SharedArrayBuffer-based VFS shared between main thread and kernel worker
- `OpfsFileSystem` — Origin Private File System for browser persistence. Its
  worker assigns session-scoped inode tokens to regular files and uses
  `FileSystemHandle.isSameEntry()` to unify simultaneous opens. Tokens remain
  stable for live handles across supported rename and unlink; unlink followed
  by recreation is a different identity. Device and inode cross the OPFS
  channel as exact unsigned 64-bit integers. A browser that lacks the required
  identity or move primitive reports the unsupported boundary rather than
  substituting a pathname identity. The OPFS proxy owns namespace mutation for
  its origin during a session and sweeps its hidden unlink-while-open orphan
  directory at startup; running multiple independent proxy workers against the
  same origin concurrently is not a supported coherence model. Regular-file
  `fsync()` calls the browser's file-handle `flush()` operation. Directory
  `fsync()` succeeds after already-completed directory operations because the
  File System API exposes no directory flush primitive; it is not an
  additional crash-durability barrier.
- `DeviceFileSystem` — `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/ptmx`
- Stable-identity regular files, including OPFS regular files on supported
  browsers, can be shared across process memories through the host mapping
  cache, but updates become visible at syscall boundaries rather than
  immediately on direct loads/stores. Cross-process futex waits/wakes remain
  unsupported; see [architecture.md](architecture.md#shared-mapping-coherence).
- Advisory locking uses `host_fstat` on the live open handle and the same
  backend-qualified identity. If a filesystem backend cannot provide a stable,
  exact identity, locking fails truthfully with `ENOLCK`; it never falls back
  to hashing the remembered path.

### Terminal
- PTY support with full line discipline
- Interactive stdin via `appendStdinData` for incremental input
- xterm.js integration via `PtyTerminal`

### Framebuffer (`/dev/fb0`)
- 640×400 BGRA32 packed-pixel framebuffer; exclusive process owner.
- The pixel buffer lives in the process's `WebAssembly.Memory` (a `SharedArrayBuffer`); the kernel notifies the host of `(pid, addr, len, w, h, stride, fmt)` on `mmap`, and the host renders via `requestAnimationFrame` + a 2D-canvas `putImageData` per frame.
- Framebuffer messages are tagged with the process execution generation. Exit
  and exec wait for `BrowserKernel` to acknowledge removal of its exact-
  generation memory wrapper and framebuffer-registry views, so a delayed
  old-image message cannot disturb a successor with the same PID. A caller
  that retains the wrapper returned by `getProcessMemory()` is outside that
  acknowledgement; JavaScript cannot prove that arbitrary consumer references
  have been garbage-collected.
- `host/src/framebuffer/canvas-renderer.ts::attachCanvas(canvas, registry, pid, opts)` is the consumer-side renderer.
- Keyboard input: the demo page maps focused browser `KeyboardEvent` values to Linux input keycodes, encodes them as MEDIUMRAW bytes, and feeds them through `appendStdinData(pid, …)`; fbDOOM-style software decodes those bytes from the tty. Ctrl+Shift+Esc is reserved as the host escape from keyboard capture.
- Limitations: `fork` does not auto-bind the child; multi-buffering / vsync via
  `FBIOPAN_DISPLAY` is a no-op. The current surface still exposes a process
  `WebAssembly.Memory` to the presentation realm. Device/CRTC-owned bounded
  shared surfaces, per-handle rights, serialized presentation, and
  multi-writer/compositor ownership remain follow-up work.

### Mouse input (`/dev/input/mice`)
- Demo pages attach `mousemove` / `mousedown` / `mouseup` listeners to the canvas and call `BrowserKernel.injectMouseEvent(dx, dy, buttons)`. The main thread posts a `mouse_inject` message to the kernel worker, which calls the kernel's `kernel_inject_mouse_event` export. The kernel encodes a 3-byte PS/2 frame and queues it on a global ring; user processes drain the queue via `read("/dev/input/mice", …)`.
- **Pointer Lock recommended.** The DOOM demo calls `canvas.requestPointerLock()` on first click so the browser delivers unbounded relative motion (`MouseEvent.movementX/Y`). Without pointer lock, `clientX/Y` deltas clamp at the canvas edges and feel sluggish for first-person controls. Press `Esc` to release the lock.
- Browser `deltaY` is positive-down; the demo inverts it before injection so the kernel queue holds canonical PS/2 (positive-up) deltas.
- Browser `MouseEvent.button` (0=L, 1=M, 2=R) is mapped to PS/2 button bits (bit0=L, bit1=R, bit2=M). Right-click suppresses the browser context menu via `contextmenu` `preventDefault()`.
- Single-owner device (one process can hold `/dev/input/mice` open at a time; second open from another pid returns `EBUSY`).

### Audio output (`/dev/dsp`)

- The kernel exposes a playback-only OSS `/dev/dsp` frontend over its generic
  PCM stream core. Applications may write U8, signed 16-bit little-endian, or
  signed 16-bit big-endian mono/stereo PCM at 8–192 kHz. The worklet converts
  those PCM concepts to the browser output format; Web Audio types are not
  exposed to guests.
- The queue is bounded and backpressured. It defaults to four 1024-byte
  fragments (4096 active bytes), within a fixed 65,664-byte transport
  allocation (128-byte control header plus 65,536-byte ring).
  The kernel never drops the oldest samples. Blocking writers sleep for
  capacity, nonblocking writers receive partial progress or `EAGAIN`, and
  `POLLOUT` requires at least one free fragment. Writes may end between PCM
  frame boundaries: later writes continue the same byte stream, while a drain
  pads only a terminal incomplete frame with format-appropriate silence.
- An `AudioWorkletProcessor`, running on the Web Audio render clock, reads the
  shared PCM ring directly, advances the kernel-visible consumer cursor, and
  outputs silence on underrun. There is no main-thread audio-drain timer and no
  second persistent PCM queue; browser-provided Float32 output buffers are
  transient. Consumption wakes blocked writes, `poll()`, and
  `SNDCTL_DSP_SYNC`/close drain waiters in the kernel worker.
- The default 4096-byte queue is about 21.3 ms at 48 kHz stereo S16. A normal
  128-frame worklet render quantum adds about 2.7 ms at 48 kHz; the browser's
  `AudioContext.baseLatency` and `outputLatency` are device-specific and must
  be measured separately. Machine teardown first waits for the shared PCM ring
  to drain. If the context is running, it then suspends the context so Web
  Audio hands already-rendered blocks to the output device and waits a bounded
  interval covering the reported base/output latency and final render quantum
  before closing the context. A suspended or interrupted context is never
  resumed implicitly during teardown.
- **A user gesture is required.** Preparing the PCM driver may leave its
  `AudioContext` suspended. The application must call the session audio-resume
  path from a click, keypress, or other browser-recognized activation. If the
  context is suspended or interrupted, the consumer cursor intentionally
  stops: the queue fills, writers apply backpressure, and drain/close stays
  pending instead of pretending audio played. Resuming the context continues
  from the queued position.
- Browser policy suspension and interruption are recoverable and do not poison
  the stream. A permanent worklet, processor, or sink failure is latched into
  the shared transport instead: blocked calls wake, `write()` and drain return
  `EIO`, `poll()` reports `POLLERR`, and final close releases the exclusive
  device after discarding only the tail that can no longer be played. A fatal
  failure during an orphan drain likewise discards the unplayable tail and
  releases ownership instead of wedging subsequent opens.
- The one physical device is exclusive by OFD. `dup()` and inherited
  descriptors share it; another `open()` gets `EBUSY`. Explicit final close
  drains. Exit or `CLOEXEC` leaves any queued tail as an orphan drain and keeps
  the device busy until the worklet reaches it. `RESET` is the explicit way to
  discard a tail. A caught signal can interrupt a blocked write, drain, or
  explicit close; write and drain honor `SA_RESTART`, while interrupted close
  leaves the fd valid for the caller to retry.
- Capture, duplex, `mmap`, OSS mixer devices, and kernel multi-client mixing
  are not implemented. `open(O_RDONLY)` and `open(O_RDWR)` fail with
  `ENOTSUP`, so browser software does not discover a fake recording device.

Node uses the same transport and state transitions. Its default headless sink
advances the consumer position from elapsed wall-clock time at the configured
sample rate and emits consumed bytes to an optional observer; it never drains
the queue instantaneously or keeps a second PCM copy. Running ticks follow the
negotiated fragment duration, preserve fractional-frame drift, and use 10 ms
idle polling. Applications therefore see the same write and SDL callback
pacing even when no physical Node audio device is attached.

## Browser Demos

Located in `apps/browser-demos/pages/`:

| Demo | Software | Boot pattern | Features |
|------|----------|--------------|----------|
| simple | C programs | legacy spawn | Basic file I/O, printf |
| shell | dash + coreutils | legacy spawn | Interactive shell with exec, pipes, PATH lookup |
| python | CPython 3.13 | `kernel.boot` | REPL + script runner |
| perl | Perl 5.40 | `kernel.boot` | REPL + script runner |
| php | PHP CLI | `kernel.boot` | Script execution |
| ruby | Ruby 3.3 | `kernel.boot` | REPL + script runner |
| node | SpiderMonkey-backed Node-compatible runtime + npm 10.9.2 | `kernel.boot` | xterm REPL; `npm install` reaches the real registry via the host fetch |
| erlang | OTP 28 BEAM | legacy spawn | Erlang VM, message passing |
| nginx | nginx | dinit | Static file serving via service worker |
| nginx-php | nginx + PHP-FPM | dinit | FastCGI, fork workers |
| mariadb | MariaDB 10.5 | dinit | SQL database with threads (Aria/InnoDB) |
| redis | Redis 7.2 | dinit | In-memory store with threads |
| wordpress | nginx + PHP-FPM + WP | dinit | Full stack with SQLite |
| lamp | MariaDB + nginx + PHP-FPM + WP | dinit | Full LAMP stack |
| mariadb-test | MariaDB + mysqltest | dinit + spawn | Playwright-driven mysql-test runner |
| benchmark | (per-suite) | legacy spawn | Micro-benchmarks + WordPress + Erlang ring |
| network | dash + GNU Netcat + curl | `kernel.boot` x 3 | Boots multiple local Kandelo machines and verifies UDP datagrams, TCP streams, and HTTP over virtual TCP |
| doom | fbDOOM | legacy spawn | `/dev/fb0` framebuffer + canvas renderer + keyboard via stdin + mouse via `/dev/input/mice` (pointer-locked) + SFX **and** OPL2-synthesized music via `/dev/dsp` → AudioContext. The shareware `doom1.wad` is **fetched at page load** from a commit-pinned CDN URL (SHA-256 verified, Cache API cached); no IWAD ships in the package archive. |

The "Boot pattern" column reflects how the demo enters the kernel:
- **`kernel.boot`** — `kernelOwnedFs: true`, exec the language interpreter as the first user process.
- **dinit** — `kernelOwnedFs: true`, exec dinit as the first user process (PID 100), which brings up the per-demo service tree; PID 1 remains synthetic.
- **dinit + spawn** — dinit boots the supervised services; the page spawns transient binaries (e.g. mysqltest) via `kernel.spawn()`.
- **legacy spawn** — main thread restores a `MemoryFileSystem`, page calls `kernel.spawn(programBytes, argv)` for each binary, and the Rust kernel allocates the PID before the worker launches it.

Run the browser app: `cd apps/browser-demos && npm run dev`, then open
`http://127.0.0.1:5401/`.

For a manual OSS playback check after changing the port, first run
`./run.sh clean fbdoom && ./run.sh build fbdoom` so an ignored local artifact
from an older package revision cannot be reused. Then run `./run.sh browser`,
select the fbDOOM demo, and click the framebuffer to satisfy the browser's
audio-activation requirement. The title-screen music checks the software OPL
path; starting a game and firing the pistol checks mixed sound effects. Quit
through DOOM's menu to exercise the normal `/dev/dsp` drain-and-close path.
This demo is a direct OSS consumer, not an SDL test; the `sdl-dsp-test` package
and host audio integration suite exercise the unmodified SDL2 and SDL3 `dsp`
backends. That suite also runs SDL_mixer 2.8.2's unmodified `playwave` example
against deterministic WAVs and compares the Node sink's consumed PCM exactly.
Browser output remains a manual audible check because the production
AudioWorklet intentionally exposes transport cursors, not rendered samples.

### Kandelo session UI

The Kandelo app at `/pages/kandelo/` keeps the running machine as the primary
browser canvas and exposes related tools through a bottom dock. Dock controls
switch between Demo, Terminal, and Internals views, while dock panes open for
new-machine setup, gallery browsing, system config, and sharing. These controls
consume `KernelHost` state and actions rather than replacing the runtime path.

The dock may be collapsed or moved horizontally within the browser viewport;
that placement is UI-only presentation state and does not alter the running
machine, boot descriptor, VFS image, or share/export data.

Image-declared demo guides from `/etc/kandelo/demo.json` remain part of the
machine presentation owned by the demo image. Guide actions may run terminal or
web actions through `KernelHost`, but they do not replace process supervision,
VFS state, networking, or runtime behavior.

Lazy VFS diagnostics have two intentionally different `KernelHost` views.
`lazyDownloadHistory()` is a 512-event chronological ring for recent transport
detail. `lazyDownloadSummaries()` is the complete attached-kernel-lifecycle
ledger: it retains one latest record per distinct asset, including its
first/start/update times and complete raw-event count. Its size grows with the
number of distinct assets retrieved during that kernel lifecycle; it has no
fixed asset cap. `subscribeLazyDownloadSummaries()` reports both event updates
and lifecycle resets. The Lazy Load inspector and acceptance tests use the
summary ledger, so response chunk volume cannot erase evidence that an earlier
download completed. Both views reset when the kernel is replaced; neither is
persisted as a machine snapshot.

Cross-origin browser fetches are routed through `public/service-worker.js`,
which defaults to `https://wordpress-playground-cors-proxy.net/?`. Only GET
and HEAD requests are wrapped in the proxy: the proxy exists to make
CORS-less read-only resources readable under COEP, and its only POST
authority is the reviewed `git-upload-pack` boundary, which targets the proxy
URL deliberately. A page-level request with any other method goes directly to
its target, so that server must grant CORS itself — the signalling piplet
(`apps/signalling/piplet.php`) does. Override the proxy with
`VITE_CORS_PROXY_URL` when testing another proxy:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

Proxy prefixes ending in a bare `?` receive raw target URLs; `?url=`-style
prefixes receive percent-encoded targets.

`BrowserKernel({ corsProxy })` applies one complete immutable proxy profile to
two independent browser transports: guest HTTP(S) requests and external lazy
VFS files or archives. Same-origin lazy assets still use direct `fetch()`. This distinction
matters in a cross-origin-isolated page: lazy materialization must read the
response bytes, so an external response must grant CORS. A CORP header can
satisfy a COEP embedding check, but it does not make an opaque no-CORS response
body readable to JavaScript. Public release assets do not necessarily grant
CORS even though an ordinary command-line client can read them. An explicit
`closedLazyAssets` set remains exhaustive and takes precedence over the network
proxy. The Node.js host is unaffected and continues to fetch its lazy URLs
directly.

The current profile allows `Accept`, `Content-Type`, `git-protocol`,
`wp_blog`, and `wp_install`. Every actual proxy boundary projects by
case-insensitive field name only and preserves browser-representable values and
occurrences as far as Fetch permits. Request fields the browser sets or
forbids on every `fetch()` — the Fetch forbidden request-header names plus
browser-owned identity/client-hint fields such as `content-length`,
`accept-encoding`, `transfer-encoding`, and `user-agent` — are omitted for
**any** method, because a guest value for them can never reach the origin
regardless of the allow-list; their omission is the browser's constraint,
not a proxy-imposed loss. This is what lets a body-bearing smart-HTTP
`git-upload-pack` POST traverse the proxy: a browser `git clone https://…`
succeeds because only the application-owned fields, all of which are
allow-listed (`Accept`, `Content-Type`, `git-protocol`), are forwarded. An
anonymous bodyless GET may additionally omit an
application-owned unsupported field and emits a deduplicated diagnostic.
Credential fields (`Authorization`, `Cookie`, `Cookie2`, `Proxy-Authorization`)
are never silently dropped; a request carrying an unsupported one fails before
dispatch. Any other application-owned unsupported field still fails a
credentialed, body-bearing, or non-GET request before dispatch. Direct Fetch
attempts remain unprojected. The development same-origin relay enforces the same
profile as production.

Bridge initialization now rejects typed CacheStorage and transition failures.
A worker disappearance or lost acknowledgement after `postMessage` remains a
known boundary: the worker may already have committed irreversible
CacheStorage authority, so a client-only timeout could reject while leaving a
discarded bridge authoritative. Closing this gap requires a coordinated
transaction, cancellation acknowledgement, and restart reconciliation.

### Blob-URL iframes (service-worker boundary)

The service worker can only bridge requests from documents it **controls**. A
`blob:` document is not service-worker-controlled (and has no base URL), so its
subresource requests bypass the bridge and hit the static origin instead of the
in-kernel server. This is a real browser boundary, not a Kandelo bug.

It surfaces in the WordPress block/site editor, whose canvas iframe is mounted
from `URL.createObjectURL(new Blob([html]))`: the canvas's
`load-scripts.php`/`load-styles.php` and block-asset requests would 404 against
the origin even though nginx serves them correctly over the bridge.

`public/blob-iframe-interceptor.js` is a reusable, framework-free DOM patch that
neutralizes this class of issue. It hooks `Blob`/`URL.createObjectURL` and the
`HTMLIFrameElement` `src` setter/`setAttribute` so that any iframe pointed at a
`text/html` blob URL is instead rendered from `srcdoc` (an `about:srcdoc`
document, which the service worker *does* control). It is idempotent and a no-op
unless a text/html blob URL is used as an iframe src. The service worker inlines
it (via the `"__BLOB_IFRAME_INTERCEPTOR__"` build-time placeholder, mirroring
`"__CORS_PROXY_CONFIG__"`) into the `<head>` of every bridged HTML document, so it
applies to all app demos, not just WordPress.

## VFS Images

### Consumer-owned product selection

VFS product definitions live under `images/vfs/products/` and describe what
an image is. They do not decide where that image appears.
Pages placement is owned only by the Pages VFS product registry.
The Pages registry is
`apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml`; test
selection is independently owned by `tests/vfs-products.toml`. Their generated
JSON files are canonical checked projections.

Pages presentation membership is a separate reviewed authority at
`apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json`.
It maps every selected Pages product to the preset IDs that present that image.
The Pages registry check requires exact product-ID parity, requires every
declared preset to exist in `presets.ts`, and verifies the preset's VFS-image
mapping in `live-setup.ts`. The retained Pages composer derives site metadata
from those exact current-main authorities and the built site tree, and binds
each normalized `vfs_image` mapping into the site identity; workflows do not
supply self-authorizing gallery or file inventories.

Hosted Pages publication is disabled, but its registry, producer, and local
fixtures remain reviewable and continue to fail closed. Before disablement,
protected main workflows invoked `scripts/abi-staging-pages-producer.ts produce`
with a bounded handoff naming the exact clean checkout, runtime bundle/root,
built site root, run identity, and current package/archive/program-index roots.
The producer discovered immutable candidate and admission records anonymously,
recaptured package inputs, and executed the normal VFS builders plus both host
evidence supervisors. Every selected product had to carry its exact
current-main recapture. Embedded recaptures remained path-only builder inputs;
only lazy recaptures received Pages input URLs. Embedded product dependencies
used the distinct ABI-, product-, digest-, and byte-bound Pages product URL.
During pre-deployment evidence, canonical Pages and prior-product lazy URLs
remained the image authority while authenticated current bytes were supplied
through a closed local transport.
The exact browser runtime used a dedicated evidence build of the real root UI.
That build kept the exact kernel asset but mapped ordinary demo rootfs and
program fallbacks to unavailable URLs. Candidate VFS and lazy inputs therefore
came only from the protected evidence handoff; an accidental fallback fetch
was observed as a failed, unexpected request instead of making runtime
preparation depend on unrelated package archives before product composition.
An incomplete product set emitted only `readiness.json`; a complete set
emitted the canonical artifacts, site manifest, and inert source tree for the
Pages job.
The canary validated that record before selecting its artifact protocol. A
hold had exactly that one file, reported its digest and blockers, and used
ordinary bounded artifact retention; it never invoked the Pages artifact
action. Only a ready result validated and uploaded the complete inert Pages
source tree.

That hosted rollout remains dormant. Re-enabling it requires a separate
reviewed change that revalidates package-backed product inputs and restores an
explicit deployment trigger; retained readiness files are not authorization.

Selection preserves both lazy boundaries. A consumer may lazily compose a
whole VFS product, and a selected product may in turn retain lazy package
layers. Product-derived package roots are not copied into either consumer
registry. This prevents a product from placing itself on Pages and prevents
Pages or tests from becoming competing software dependency authorities.

The atomic local snapshot gate also drives the one producer-returned, assembled
seven-product tree through the production `/kandelo/` Vite base, service
worker, cross-origin isolation headers, and `BrowserKernel` in Chromium. It
holds the two eager VFS responses, proves no lazy request starts before their
release, then proves each lazy product is fetched only by its representative
profile. It hashes every VFS response and rejects external requests plus
noncanonical identity, load, ABI, length, and digest mutations. The
hidden deployment manifest is only the test's observation ledger; the sealed
build map remains browser authority. This is bounded fixture evidence, not a
claim about hosted candidate publication, a real pull request, canonical
promotion, or production Pages deployment.

Browser demos use pre-built **VFS images** — binary snapshots of a `MemoryFileSystem` containing all runtime files, directory structure, configs, and symlinks needed by a demo. At runtime, restoring a VFS image is a single buffer copy, replacing what would otherwise be hundreds or thousands of individual file creation operations.

### How it works

1. **Build time**: A TypeScript build script creates a `MemoryFileSystem`, writes files/dirs/symlinks into it, and calls `saveImage()` to produce a zstd-compressed `.vfs.zst` file. Empty regions of the SharedFS allocator compress to nearly nothing, so a 32 MB filesystem with a few MB of real content typically ships as a 1–3 MB download. If the image should grow or report a larger `df` capacity at runtime, build it with `MemoryFileSystem.create(sab, permittedMaxBytes)` so the filesystem metadata is sized for that capacity.
2. **Runtime**: The demo page fetches the `.vfs.zst` file and awaits
   `restoreVerifiedVfsImage(imageBytes, { maxByteLength })`. The helper
   auto-detects zstd magic, restores the filesystem, and authenticates every
   imported atomic lazy-tree seal before returning. Only then may the consumer
   inspect, mutate, rewrite, or pass the filesystem to `BrowserKernel({
   memfs })`. `maxByteLength` makes the restored `SharedArrayBuffer` growable;
   it does not raise the filesystem maximum beyond the image's superblock
   limit.

The canonical package shell has a 512 MiB filesystem ceiling. Products that
copy that shell and add their own application tree use a separate 768 MiB
profile: SharedFS derives its fixed inode-table size from the declared byte
ceiling, so merely having free data blocks does not guarantee that another
file can be created. `saveShellDerivedVfsImage()` rejects a product build
unless at least 64 MiB of data blocks and 8,192 inode slots remain after its
immutable contents are written. This makes runtime allocation space a checked
artifact contract instead of allowing an image to build successfully and then
fail with `ENOSPC` during normal browser initialization. The shared save helper
also preserves the shell's ABI and exact package-shell composition while
rebinding the exact shell artifact as the derived product's direct base and
replacing its builder id and capacity. It validates the inherited experimental
terminal-session declaration and requires
the serialized artifact's encoded growth ceiling and capacity metadata to equal
the 768 MiB product profile. A future product that intentionally needs a larger
reviewed profile must pass that exact ceiling explicitly rather than silently
drifting from its browser consumer; an override cannot select a smaller
profile. Host-tree copies fail the build on any read or VFS write error.
Intentional omissions are declared through the copy helper's `exclude` option,
and every unexcluded symlink must be preserved explicitly or the build fails.

`saveImage()` also walks every materialized Wasm file and rejects stale ABI or
fork-instrumentation state. A package that intentionally disables fork
instrumentation may narrow that check only with an exact canonical VFS path in
`wasmArtifactPolicies`; the builder's declaration must agree with the selected
generated package projection. Missing, deferred, non-Wasm, duplicate, or
noncanonical policy paths fail the build, and all other Wasm paths retain the
normal whole-image validation. `skipWasmArtifactCheck` is not an alternative
for a product-specific executable policy. A direct dependency may authorize
such a policy only from its exact immutable xtask program-cache generation,
including the selected cache key and declared source-artifact path. Generic VFS
artifact lookup continues to support relocated build inputs and local source
overrides, but those paths do not carry enough identity to authorize a Wasm
validation exception without a separate content-bound receipt.

Gallery launch URLs retain both the logical demo id and the resolved VFS image
URL. Each built-in VFS image has one trusted source and resource identity; the
logical id separately selects launch behavior. This lets the shell, Doom, and
modeset demos reuse the same shell image without creating multiple trusted
image profiles. The loader verifies that the URL exactly matches the current
built-in image before granting its larger resource limit. A query parameter or
URL fragment cannot give an unrelated image that limit; images consumed by the
general live host use the bounded custom-image profile when they do not match.
The specialized Node host always boots its fixed built-in image rather than
consuming a `vfs` override.

```typescript
// Typical demo pattern
import { restoreVerifiedVfsImage } from "@host/vfs/load-image";

const [kernelBuf, vfsImageBuf] = await Promise.all([
  fetch(kernelUrl).then(r => r.arrayBuffer()),
  fetch(vfsImageUrl).then(r => r.arrayBuffer()),
]);

const memfs = await restoreVerifiedVfsImage(
  new Uint8Array(vfsImageBuf),
  { maxByteLength: 512 * 1024 * 1024 },
);

const kernel = await BrowserKernel.create({ kernelWasm: kernelBuf, memfs });
```

### Kandelo demo metadata

VFS images can also carry UI presentation metadata at `/etc/kandelo/demo.json`.
The Kandelo live loader reads this file immediately after restoring the image,
before kernel instantiation, and uses it to decide which surface should be
primary during boot and after the demo is ready. This keeps demo-specific UI
preferences with the image instead of hardcoding them in the page loader.

```json
{
  "version": 1,
  "profiles": {
    "wordpress-sqlite": {
      "presentation": {
        "bootPrimary": "syslog",
        "runningPrimary": ["web", "terminal", "syslog"],
        "terminalAccess": "drawer",
        "internalsAccess": "drawer"
      }
    }
  }
}
```

Use `writeKandeloDemoConfig()` from
`images/vfs/scripts/kandelo-demo-config.ts` in VFS build scripts. Images
without this file still boot with Kandelo's generic presentation defaults, but
the Kandelo app does not carry demo-specific presentation fallbacks.
Any extra files needed by an image-declared `autoCommand` can be declared in
`assets`; the loader stages those paths generically and hash-verifies them when
`sha256` is provided.

A profile may also declare one fixed-path file-ingest capability. The current
Kandelo browser UI presents it on the framebuffer surface as a file picker and
drop target:

```json
{
  "ingest": {
    "accept": [".wad"],
    "targetPath": "/user.wad",
    "maxBytes": 33554432,
    "label": "Load WAD",
    "onLoad": {
      "restart": "/usr/local/bin/fbdoom -iwad /user.wad"
    }
  }
}
```

The image, not the uploaded filename or profile name, owns `targetPath` and the
optional restart command. The path must be absolute and normalized, its parent
must already exist, extensions are matched case-insensitively, and `maxBytes`
cannot exceed 64 MiB. The browser checks both the file's declared size and the
actual buffer length. It writes before stopping a current device owner, then
uses the kernel signal path and bounded process/device waits before dispatching
the image-owned command. Write, signal, timeout, and command-dispatch failures
remain visible. An absent `ingest` block means the image exposes no upload
capability; the loader does not infer one from a package or profile name.

The runtime treats this file as untrusted image input. It must be a regular
file no larger than 256 KiB, contain valid UTF-8 and JSON, and use a supported
version. The loader validates every profile before using any of them, so a
malformed unselected profile cannot hide behind the current URL. Producers
that already have a reviewed canonical JSON file may copy those exact bytes;
the package-built main shell uses
`packages/registry/shell/source-rootfs-shell-demo.json` as its single reviewed
source.

VFS images do not need to serialize placeholder device nodes. Both Node and
browser boot replace `/dev` with the authoritative `DeviceFileSystem` and mount
shared memory at `/dev/shm`; image acceptance should exercise devices such as
`/dev/null` only after those runtime mounts exist.

KMS demos use the same metadata path. A profile can set
`runningPrimary` to include `"kms"` and provide an `autoCommand` such as
`/usr/local/bin/modeset`; the VFS image must contain that executable. The
Kandelo app attaches the KMS canvas through the generic KMS surface plumbing,
then runs the image-declared command. Do not add browser-loader branches that
import or spawn a specific `modeset.wasm` file.

Images can also declare an optional `guide`. When `guide` is absent, Kandelo
does not render a demo panel; this is the intended shape for demos where the
primary surface is enough, such as WordPress and Doom. A guide can contain
button groups, an editable shell script, and optional companion HTML:

```json
{
  "version": 1,
  "profiles": {
    "node": {
      "guide": {
        "title": "Node.js demo",
        "groups": [{
          "title": "REPL",
          "actions": [
            {
              "id": "enter-repl",
              "label": "Open REPL",
              "kind": "terminal.run",
              "payload": "node"
            },
            {
              "id": "send-expression",
              "label": "Send expr",
              "kind": "terminal.write",
              "payload": "process.version\n"
            }
          ]
        }]
      }
    }
  }
}
```

### Experimental image-owned terminal sessions

An image selects its terminal program with the strict experimental file
`/etc/kandelo/experimental-terminal-session.json`:

```json
{
  "kind": "kandelo-experimental-terminal-session",
  "version": 1,
  "initial": {
    "path": "/usr/bin/login",
    "argv": ["login", "-p", "-f", "maker"],
    "uid": 0,
    "gid": 0
  },
  "afterExit": {
    "path": "/usr/bin/login",
    "argv": ["login", "-p"],
    "uid": 0,
    "gid": 0
  }
}
```

This file completely replaces `/etc/kandelo/shell.json`; the browser neither
reads the old path nor supplies a fallback shell. The experimental name is an
intentional warning that this image-facing session-supervision contract is not
stable. A missing, malformed, oversized, or unsupported declaration fails
loudly.

The loader parses the declaration from the fully staged VFS image, rejects
unknown fields, bounds the document, paths, arguments, and guest IDs, requires
normalized absolute executable paths, and verifies each configured program is
an executable regular file. It then launches the program through the kernel's
normal VFS `exec` path. First-party and custom images use exactly the same
parser and supervisor; image origin does not select terminal behavior.

Each newly allocated logical terminal starts `initial` once. When that process
exits, the same terminal starts `afterExit`, when present, with bounded restart
backoff. Closing and reopening the terminal UI only detaches and reattaches its
renderer; it neither repeats the initial program nor replaces the guest
process. Removing the logical terminal, detaching the kernel, rebooting, or
destroying the host stops its active process and cancels pending restarts.

The canonical rootfs uses root-started `login -p -f maker` as `initial`, then
ordinary `login -p` after logout. Authentication and preauthentication remain
inside the guest `login` program and ordinary VFS account files, not React.
`login` is an eager root-owned `04755` package output; `sudo-lite` and `sudo`
are root-owned `04755` lazy outputs. The writable root image honors those
set-ID modes unless its mount explicitly requests `nosuid`.

`terminal.run` sends a command through the persistent PTY-backed shell.
`terminal.write` sends raw text to that PTY, which is useful for entering input
into an already-running REPL. `guide.companion.srcDoc` runs in a sandboxed
iframe and has no direct kernel access; it can only request parent-approved
actions by posting `{ type: "kandelo.demoAction", actionId }`.

When changing metadata for an existing package-backed image, bump that
package's `build.toml` `revision` so published/fetched binaries are rebuilt.
For local browser artifacts, force a rebuild with `./run.sh rebuild <target>`.

### VFS images per demo

| Demo | Image | Build command | What's inside |
|------|-------|--------------|---------------|
| Python (legacy opt-in) | `python-vfs.vfs.zst` | `bash packages/registry/python-vfs/build-python-vfs.sh` | ABI-bound CPython interpreter, complete stdlib, license, aliases, and demo metadata |
| Erlang (legacy opt-in) | `erlang-vfs.vfs.zst` | `bash packages/registry/erlang-vfs/build-erlang-vfs.sh` | ABI-bound BEAM emulator, relocatable core OTP tree, executable helpers, and boot files |
| Perl | `perl.vfs.zst` | `bash images/vfs/scripts/build-perl-vfs-image.sh` | Perl stdlib |
| Shell | `shell.vfs.zst` | `./run.sh build shell-vfs` | package-built platform rootfs plus shell demo assets; Bash and login are embedded, while sudo and the ordinary command set remain first-use package outputs |
| Node | `node-vfs.vfs.zst` | `bash images/vfs/scripts/build-node-vfs-image.sh` | exact lazy shell image plus the package-resolved Node executable, npm 10.9.2 distribution, writable `/work`, and Node demo metadata |
| WordPress | `wordpress.vfs.zst` | `bash images/vfs/scripts/build-wp-vfs-image.sh` | WP files, nginx/PHP configs |
| LAMP | `lamp.vfs.zst` | `bash images/vfs/scripts/build-lamp-vfs-image.sh` | MariaDB + WP + configs |
| MariaDB test | `mariadb-test.vfs.zst` | `bash images/vfs/scripts/build-mariadb-test-vfs-image.sh` | MariaDB + test suite |

Node, WordPress, and LAMP are optional demo profiles. Their VFS asset imports
are resolved only after that profile is requested; loading the main shell does
not require or fetch those image bytes. If the selected profile's local or
resolver-managed artifact is absent, the browser reports that exact missing
image and asks the user to run `./run.sh fetch`.

The standalone MariaDB demo and MariaDB test images run `mariadbd` as the
`mysql` account (uid/gid 101). Their writable `/data` directories are
therefore serialized as `101:101` with mode `0775`; `/tmp` remains a
root-owned `01777` sticky directory.

Generated VFS images are `.gitignore`d rather than committed. Package-backed
images can be materialized from a current public package archive; the normal
resolver falls back to the package's source recipe when needed. The `run.sh`
script handles this automatically before starting the browser.

### Building VFS images

Package-backed image recipes resolve their declared dependencies rather than
reading another package's source/build side effects. The disabled legacy
`python-vfs` recipe, for example, consumes CPython's `python.wasm` and
`python-runtime.zip` closure. These compatibility recipes are excluded from
staging. For the active browser
products, use the local DAG command in
[Package Management](package-management.md#local-dag-build); it selects the
product manifests and every transitive package input before invoking a
builder. Individual legacy image targets remain available for focused work:

```bash
./run.sh build python-vfs    # Build Python VFS image
./run.sh build shell-vfs     # Build Shell VFS image
```

The main shell target resolves the canonical `packages/registry/shell` package
into `local-binaries`; it does not invoke another package's source tree or
fbDOOM build directly. The package recipe restores the exact package-built
platform rootfs, adds the package-owned shell demo data, and serializes one
image. Bash and `login` are embedded boot inputs. `sudo-lite`, upstream `sudo`,
and the ordinary command set retain authenticated package-backed lazy outputs
that resolve through the normal VFS path on first use.
`./run.sh --fetch-only build shell-vfs` refuses source fallback.

Shell-derived packages consume that resolved image as a declared dependency.
Their builders preserve capacity, ABI identity, package-backed lazy transports
and seals, and record the exact shell digest and byte count in their own
metadata. A revision bump on the shell therefore changes the cache key of
`node-vfs`, `nginx-vfs`, `nginx-php-vfs`, `lamp`, and `wordpress` through the
normal dependency graph.

Hosted GitHub Pages publication is disabled. Its retained workflow is outside
the active workflow directory, and package activation no longer dispatches a
deployment. The normal `run.sh browser` path and pull-request browser suite
remain active consumers of the same package-built VFS products. Re-enabling a
hosted site requires separate review and fresh package-backed deployment
evidence; an older hosted site is not evidence for the current source or
package index.

The dormant source-rootfs and eager closed-selection implementations
remain diagnostic and historical recovery plumbing. Normal browser startup,
package staging, and active continuous integration do not invoke them. Retired
lazy formats do not gain compatibility shims.

### Adding a new VFS image

1. Create `images/vfs/scripts/build-<name>-vfs-image.ts` — import helpers from `vfs-image-helpers.ts`
2. Create `images/vfs/scripts/build-<name>-vfs-image.sh` — shell wrapper that runs the TypeScript script
3. If the image is consumed by Kandelo, write `/etc/kandelo/demo.json` via `writeKandeloDemoConfig()`
4. If the image is consumed by the Kandelo UI, expose it through a gallery
   manifest, preset, or direct `vfs` URL so the UI can fetch the `.vfs.zst`
   image and await `restoreVerifiedVfsImage()` before inspecting or booting it
5. Add a build target in `run.sh`

The shared helpers in `vfs-image-helpers.ts` provide:
- `writeVfsFile(fs, path, content)` / `writeVfsBinary(fs, path, data)` — write files
- `ensureDirRecursive(fs, path)` — create directory trees
- `symlink(fs, target, path)` — create symlinks
- `walkAndWrite(fs, hostDir, mountPrefix, opts?)` — recursively walk a host directory into the VFS
- `saveImage(fs, outFile)` — save and write the image to disk

## Vite Configuration

```typescript
// vite.config.ts
export default {
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
};
```

### Local SourceOnly development

`./run.sh browser` is the normal development entry point. It runs or resumes
the complete local SourceOnly DAG, exports its validated
`local-binaries/source-only-v1` projection to Vite, and starts the development
server. It does not fetch a browser binary index. Unchanged package and
product nodes are reused from the content-addressed
cache.

The development server reads VFS products directly from that projection. The
authenticated VFS group below belongs to production output and is generated
only when building a deployable directory-scoped distribution.

### Directory-scoped production hosting

A production build owns one normalized absolute deployment prefix. Build and
host the output with the same value: output built with `VITE_BASE=/a/` must be
served at `/a/`, and output built with `VITE_BASE=/candidate-b/` must be served
at `/candidate-b/`. A completed build is not freely relocatable, and
`base: "./"` is not a supported substitute for choosing its public path.

The SourceOnly local DAG described in
[Package Management](package-management.md#local-dag-build) is the canonical
way to build the seven active VFS products. Produce
`local-binaries/vfs-group` and its private product map, then pass both explicit
paths to each production build:

```bash
export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
npx tsx scripts/build-local-vfs-asset-group.ts \
  "$PWD/local-binaries/vfs-group" \
  "$PWD/local-binaries/pages-vfs-products.private.json"
export KANDELO_PAGES_PRODUCT_MAP="$PWD/local-binaries/pages-vfs-products.private.json"
export KANDELO_PAGES_VFS_ASSET_GROUP_DIR="$PWD/local-binaries/vfs-group"

VITE_BASE=/a/ npm --prefix apps/browser-demos run build -- \
  --outDir "$PWD/build/a" --emptyOutDir
VITE_BASE=/candidate-b/ npm --prefix apps/browser-demos run build -- \
  --outDir "$PWD/build/candidate-b" --emptyOutDir
```

Vite authenticates and copies the complete group beneath the owning output as
`vfs-groups/release-1/`: manifest, seven unchanged images, and all 80 lazy
assets. The private map is not published. Changing the public group path
requires regenerating the complete manifest/images/assets handoff, updating
the private map to its new manifest path, and rebuilding the distribution.
Never move a group within an already completed build. Its complete group must
remain beneath the owning prefix; moving only an image or asset also breaks
the authenticated inventory.

Each output places `service-worker.js` at its prefix root. The bootstrap
registers that exact script with its own script-directory scope (`/a/` or
`/candidate-b/`). Servers must not grant a broader scope with
`Service-Worker-Allowed`: one worker must never control `/` or a sibling
deployment. Bridge authority, cookie jar, cross-origin-isolation retry marker,
and lazy VFS cache are separately namespaced by registration scope. Restarting
one worker restores only that prefix's durable state. The Kandelo theme is the
intentional origin-wide exception because it is ordinary `localStorage` UI
preference state, not machine, bridge, cookie, retry, or VFS state.

The production coexistence scenario has been measured in Chromium with `/a/`
and `/candidate-b/`: both shells booted, Vim materialized from each prefix's
own lazy cache, and restarting/updating `/a/` left `/candidate-b/` usable and
unchanged. This is evidence for that scenario, not a claim that every browser,
host configuration, or arbitrary prefix pair was exercised.

If one prefix retains a stale worker, unregister only that exact registration
from a page on the same origin, then reload that prefix:

```javascript
const selectedScope = new URL("/a/", location.origin).href;
for (const registration of await navigator.serviceWorker.getRegistrations()) {
  if (registration.scope === selectedScope) await registration.unregister();
}
location.assign(selectedScope);
```

Do not clear all origin storage: that would erase sibling deployment state and
the origin-wide theme preference instead of repairing the selected owner.

During development, `@binaries/...` imports can resolve to canonical package
members outside the checkout. Vite's directory allow list is only transport
plumbing: a pre-serving guard permits the exact regular files approved by the
binary resolver and rechecks their real paths on every request. Other program
cache entries, source-cache files, symlink escapes, malformed filesystem URLs,
and descendants created by replacing an approved file with a directory receive
HTTP 403. Production builds emit ordinary bundled assets and do not expose the
local package cache.

With `WASM_POSIX_RESOLUTION_POLICY=source-only-v1`, the browser build also
requires `WASM_POSIX_SOURCE_ONLY_BINARY_ROOT` to be a normalized canonical
absolute directory. Its fixed
`.kandelo/source-only-program-projection-v1.json` authority is capped at
16 MiB and embeds the selected `kandelo-program-packages-v2` projection plus
sorted package nodes and their materialized member mode, size, and SHA-256.
The resolver validates exact node ownership and the complete owning package
closure. It does not fall back to `local-binaries`, fetched/indexed binaries,
the ordinary compiled cache, or an installed host package.

SourceOnly materializations are regular files and may be replaced by a later
producer run. Vite therefore parses one aggregate authority for its lifetime,
captures its authored kernel, rootfs, and program request batch against that
generation, and copies the verified bytes into a private immutable temporary
directory. The complete retained set is limited to 512 MiB before allocation.
Development streams those snapshots from a content-addressed virtual endpoint;
production emits the same snapshots as normal Rollup assets. Exact optional
mirror globs are rewritten through that boundary, while package-output and
public artifact globs are forced absent instead of becoming fallback tiers.
Array-valued globs are rejected before Vite because the browser binary scanner
admits only one exact scalar path per request. SourceOnly also gives Vite a
private snapshot of the commit-bound authored static-file allowlist in
`public/`; every other ambient file is denied in development and omitted from
production regardless of its suffix.

Verified lazy ZIP and gzip/TAR decoding is linked into each browser worker by
inlining that worker build's dynamic imports. Source-level dynamic imports stay
lazy in the shared and Node.js paths, while browser workers trade some initial
parse and download size for a terminal emitted bundle that cannot depend on an
entry after Vite removes its synthetic exports. The production graph guard
rejects every static or dynamic edge back to a stripped entry, including a
binding-free static edge that would still evaluate the stripped entry.

Optional php, SQLite, and benchmark inputs still depend on ambient build
outputs and are therefore rejected under SourceOnly; the supported root build
inputs are `main`, `kandelo`, and `network`.
The configured SourceOnly root remains the only external filesystem root in
Vite's allow list, and direct `/@fs/` requests for its members remain forbidden.
Other pathname resolver APIs validate the named file and artifact policy
against one stable descriptor read, but the returned path remains a
point-in-time result; callers that retain a path across producer runs must
resolve it again.

## Known Limitations

### SharedArrayBuffer restrictions
Chrome rejects SharedArrayBuffer-backed views in `TextDecoder.decode()` and `crypto.getRandomValues()`. Always copy to a temporary non-shared buffer first.

### Network lab multi-kernel completion

The `/pages/network/` demo currently has a browser-worker scheduling
regression when two independent kernel instances run GNU Netcat concurrently.
The UDP payload is delivered through `LocalVirtualNetwork` and appears in the
receiver's stdout, but both process workers can stop making progress before
exit; the subsequent TCP and curl scenarios therefore do not start. The
Playwright scenario is marked as an explicit expected gap until the browser
multi-kernel completion path is fixed. Node.js virtual-network tests continue
to exercise packaged Netcat UDP and TCP traffic, so this limitation does not
claim that browser completion is working based on Node-only evidence.

### No external raw sockets
Browser sandboxing prevents Kandelo from listening on real network ports or opening raw TCP/UDP sockets to arbitrary external peers. Local loopback sockets and `LocalVirtualNetwork` listeners are virtual sockets inside the browser session, so Kandelo machines can still communicate with each other using POSIX UDP/TCP. Browser-facing HTTP server demos use a service worker to intercept HTTP requests and inject them as kernel TCP connections via the connection pump.

### Memory per process
Each process gets a fresh memory layout whose requested initial pages cover the
program's imported minimum memory and low syscall control area; it does not
allocate `maxPages` at spawn. Every process generation receives a newly
constructed `WebAssembly.Memory`, and an exited generation is never reused by a
later process. `maxMemoryPages` still caps each backing's guest brk/mmap growth
and should be tuned for workloads that need large address spaces. Fork
synchronously copies the parent's exact current byte length into another fresh
backing so its observable `memory.size()` and accessible address-space boundary
match the parent before any asynchronous Worker launch work can yield. Before
constructing that backing, fork synchronously checks both live capacity and
the retired-generation count and byte thresholds. Saturated retirement debt
returns `EAGAIN` without allocating or copying another full address space; an
asynchronous pre-copy wait would let another parent thread invalidate the
fork-time snapshot.

Browser `Worker.terminate()` is not treated as proof that a Worker stopped
touching shared memory. Cooperative exit and exec publish an exact terminal
message after worker-main returns. Forced paths drop host aliases without ever
recycling the backing. Whole-kernel destroy terminates nested process/thread
Workers before terminating the containing kernel Worker realm, which is the
final fallback for incomplete graceful detach.

`maxProcessMemoryBytes` is a sampled allocation-admission budget, not a hard
aggregate growth cap: direct `WebAssembly.Memory.grow()` has no JavaScript
callback, so the next process allocation is where the allocator observes and
rejects an over-budget live set. A short retirement threshold similarly pauses
new churn after it is crossed, but an already-grown generation or simultaneous
exits can exceed it. JavaScript cannot hard-bound native backing that the
browser engine has not reclaimed. Garbage-collection observations and bounded,
coalesced ordinary-allocation pressure are diagnostic/reclamation aids only.

### npm registry access in the browser

The Node demo uses npm's canonical `https://registry.npmjs.org/` registry.
Registry metadata and tarballs traverse the ordinary browser TLS and configured
proxy boundary. Kandelo does not rewrite registry URLs, package metadata, or
tarball locations and has no npm- or package-specific proxy routing.
