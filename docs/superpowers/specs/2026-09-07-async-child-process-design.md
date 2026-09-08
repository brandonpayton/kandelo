# Async child_process for spidermonkey-node (M2 Phase K) — Design

## Why

Headless `claude -p` boots, loads its module graph, decompresses assets, and
dispatches loaders (Phases A–J), then **hangs**. A syscall trace
(`KERNEL_SYSCALL_LOG=1`) pinned the cause: the app shells out, the spawned
`/bin/sh` blocks forever on `read(0) = EAGAIN` (its stdin never gets EOF), and
the parent `wait4`s it — a subprocess deadlock. `--version` never spawns, so it
is unaffected.

The root cause is that spidermonkey-node has **no real subprocess model**.
node-compat's entire `child_process` funnels through `std.popen(cmd, 'r')` —
synchronous, read-only, fully buffered, `pid: 0`, no stdin, no streaming, no
signals. `spawn`/`exec`/`execFile` merely wrap that blocking call in
`queueMicrotask` to *look* async. The Claude Code agent loop needs to spawn
tools (shells, `rg`, git, a detached worker), stream their stdio, write to
their stdin, learn their exit code, and kill them — none of which the current
layer can do.

This phase builds a **real asynchronous `child_process`** on a small,
general POSIX primitive surface, deliberately chosen (over a subprocess-only
seam) to surface and fill the runtime's genuinely-missing async primitives:
non-forking spawn, generic async fd I/O, child reaping, `kill`, and
functioning real-delay timers.

## Background: the primitive map (verified 2026-09-07)

Full investigation in `.superpowers/notes-phasek-primitives.md`. The load-bearing
facts:

- **node.wasm is a concatenation**: `adapter.js` (defines `os`/`std`/`_nodeNative`
  shims over the SpiderMonkey shell) + shared `bootstrap.js` (import lines
  stripped) + `suffix.js`, per `build-spidermonkey.sh:293-320`. So `os`/`std`/
  `_nodeNative` in bootstrap.js resolve to adapter.js's objects. QuickJS is gone;
  "qjs" comments are stale.
- **Current `child_process`** (`bootstrap.js:2712-2823`): everything → `execSync`
  → `std.popen` → `os_popenRead` (patch 0012:705-747) → libc `popen(cmd,"r")` +
  `pclose()`. Synchronous, buffered, read-only, `pid:0`, `spawn().stdin` has no
  `_write`.
- **The only working async I/O** is the socket/TLS seam: `_nodeNative.socket*`/
  `tls*` return Promises, backed by `KandeloSocketWatch`/`KandeloSocketDispatch`
  (patch 0012:1380-1546), a non-blocking `poll(...,0)` watch list drained each
  pass of SpiderMonkey's job-queue loop (patch 0012:2072-2085). The loop stays
  alive iff `KandeloSocketHasWatches()`. Each socket op is literally `read(fd,…)`/
  `write(fd,…)` on an fd — **not socket-specific** under the hood.
- **`os.setReadHandler` is a hard no-op** (adapter.js:216) — dead code; not a
  usable primitive.
- **No `fork`/`execve`/`posix_spawn`/`pipe`/`dup2`/`wait4`/`kill` reaches JS.**
  `process.kill`→`os.kill` is a silent no-op; no SIGCHLD.
- **Real-delay timers are dead**: `os.setTimeout` (adapter.js:217-226) queues to
  `pendingTimers`; the drain (`__kandeloRunDueTimers`/`__kandeloNextTimerDelay`,
  adapter.js:262-263) has **zero callers**. Only the `ms===0` (`queueMicrotask`)
  branch fires today.
- **Kernel is ready**: `runtime-core` implements `posix_spawn` as a *non-forking*
  spawn with file-actions `Close`/`Dup2`/`Open`/`Chdir` (`process_table.rs:1297-
  1363`) and `SpawnAttrs` (`spawn.rs:221`). musl exposes the full
  `posix_spawn_file_actions_*` API incl. `addchdir_np` (`spawn.h:70-75`).
  Anonymous-pipe EOF is sticky and shared correctly with inherited fds
  (`pipe.rs:1239-1253`). Host launches children as their own Workers
  (`*-kernel-worker-entry.ts`).

## Semantic preservation (`posix_spawn` vs Node `spawn`)

`posix_spawn` is the correct spawn primitive: forking from node-compat would fork
the *entire node.wasm runtime* (the heavy fork-instrument continuation capture),
whereas `posix_spawn` launches a fresh program. It preserves the observable Node
`ChildProcess` semantics:

| Node `spawn` option / behavior | Mechanism | Status |
|---|---|---|
| `command`, `args` (argv) | posix_spawn argv | **Full** |
| `env` | posix_spawn envp | **Full** |
| `stdio`: `'pipe'`/`'ignore'`/`'inherit'`/int fd | `Dup2`/`Close`/`Open(/dev/null)` file-actions | **Full** |
| `cwd` | `addchdir_np` → `FileAction::Chdir` → `sys_chdir` | **Full** |
| `pid` | posix_spawn return | **Full** |
| exit `code` / `signal` | `waitpid` | **Full** |
| `child.kill(sig)` | `kill(pid,sig)` | **Full** |
| `shell: true` | wrap in `/bin/sh -c` (JS-side) | **Full** |
| `detached` / `setsid` / process group | `SpawnAttrs` flags parsed but **not implemented** by the kernel (`spawn.rs:219`) | **Boundary** — child runs; no new session/pgroup |
| `uid` / `gid` (`RESETIDS`) | attr parsed, not implemented | **Boundary** — ids not changed |

Boundaries are **documented, not silently swallowed**: if a caller passes
`detached`/`uid`/`gid`, the child still spawns and runs (the flag is honored to
the extent the kernel implements it, which is currently a no-op for the
session/pgroup/id change) and the limitation is recorded in `posix-status.md`.
Making the kernel implement `SETSID`/`SETPGROUP`/`RESETIDS` is a separate
runtime-core change, out of scope here.

## Global Constraints

- **ABI-neutral.** Uses the **existing** kernel syscalls (`posix_spawn`, `pipe`,
  `wait4`, `kill`, nonblocking `read`/`write`, `chdir`) via libc from the
  node.wasm guest. No new syscall number, no changed marshalling, no
  `repr(C)`/`ABI_VERSION`/`abi/snapshot.json` change. The C changes are in the
  SpiderMonkey shell layer (a new patch + generalizing patch 0012's watch code);
  the JS changes are in node-compat `bootstrap.js` (baked into node.wasm).
- **Faithful/holistic, no app-shaped compromises.** Implement real Node
  `ChildProcess` semantics; document genuine kernel boundaries
  (`detached`/`uid`/`gid`), never fake them.
- **Fail loud.** A failed `posix_spawn` (e.g. ENOENT) surfaces as a real
  `'error'` event / thrown error with the errno, matching Node — never a silent
  hang.
- **Reuse the proven pattern.** The async-fd + child-reap watches extend the
  existing `KandeloSocketWatch` job-queue-integrated poll mechanism, not a new
  event loop.
- **Two rebuilds:** node.wasm (`./run.sh build spidermonkey-node`, ~35 min,
  targeted, redirect+grep). Guest test fixtures (echo/cat/exit helpers) may need
  `build-programs.sh` (fast) if not already present as staged programs.

## Architecture

Three layers, bottom-up:

```
C native seam (new patch + patch-0012 generalization)
  posix_spawn / pipe / fdRead / fdWrite / fdClose / waitpid / kill
  + generalized watch list (arbitrary fds + child pids) in the job-queue poll loop
  + wire the dead timer drain into that same loop
        │  _nodeNative.* (delegated through adapter.js whitelist)
        ▼
node-compat child_process (pure JS, bootstrap.js)
  real ChildProcess: streaming stdin/stdout/stderr, pid, 'exit'/'close', kill()
  spawn / exec / execFile on the primitives; spawnSync/execSync stay on popen
        │
        ▼
the Claude Code app (unmodified)
```

### Component 1 — native syscall + async-fd seam (C)

New natives, exposed via `_nodeNative` and delegated in adapter.js's whitelist:

- `__kandeloSpawn(file, argvArray, envArray, actions, attrs) → pid` — builds a
  `posix_spawn_file_actions_t` from `actions` (an array of `{op:'dup2',from,to}` /
  `{op:'close',fd}` / `{op:'open',fd,path,flags,mode}` / `{op:'chdir',path}`) and
  a `posix_spawnattr_t` from `attrs`, calls `posix_spawn(&pid,file,&fa,&at,argv,
  envp)`, returns the pid or throws with the errno on failure. `shell:true` and
  argv assembly are handled JS-side before calling this.
- `__kandeloPipe() → [readFd, writeFd]` — `pipe2` with both ends set
  `O_NONBLOCK`.
- `__kandeloFdRead(fd, maxBytes) → Promise<ArrayBuffer>` — one non-blocking
  `read`; on `EAGAIN` registers a read watch and resolves when ready; resolves an
  empty buffer on EOF (`read` returns 0); rejects with errno on error. (This is
  patch 0012's `socketRead` generalized to any fd.)
- `__kandeloFdWrite(fd, bytes) → Promise<number>` — non-blocking `write`, watch on
  `EAGAIN`, resolves bytes written. (Generalized `socketWrite`.)
- `__kandeloFdClose(fd)` — `close(fd)`.
- `__kandeloWaitPid(pid) → Promise<{code, signal}>` — registers a child-reap
  watch; each poll pass does `wait4(pid, …, WNOHANG)`; on exit resolves with the
  decoded exit code or terminating signal.
- `__kandeloKill(pid, sig) → int` — `kill(pid, sig)`; returns 0 or throws errno.

Watch-list generalization (patch 0012:1380-1546, 2072-2085): add an fd-read /
fd-write / child-reap watch kind (or a parallel list), and extend the keep-alive
predicate so the process stays alive while **any** pipe read/write or child
watch is pending (today only `KandeloSocketHasWatches()`). One `poll`/`wait4`
sweep per job-queue pass, non-blocking, same 1 ms idle backoff.

### Component 2 — timer drain fix (C/JS)

Wire the existing, currently-uncalled `__kandeloRunDueTimers()` into the
job-queue poll loop (call it each pass alongside `KandeloSocketDispatch`), and
count "has pending timers" (`__kandeloNextTimerDelay() !== null`) into the
keep-alive predicate and the idle-backoff duration. This makes real-delay
`setTimeout`/`setInterval` fire. Small, self-contained, and a prerequisite:
async subprocess consumers routinely `setTimeout` (timeouts on child output,
retry backoffs), so leaving timers dead would just relocate the hang.

### Component 3 — node-compat `child_process` rewrite (JS)

Replace the popen-backed `spawn`/`exec`/`execFile` with a real implementation on
the primitives, returning a genuine `ChildProcess` (an `EventEmitter`):

- Parse `options.stdio` (default `['pipe','pipe','pipe']`; accept the string
  shorthands `'pipe'`/`'ignore'`/`'inherit'` and per-fd arrays and integer fds).
  For each `'pipe'` leg create a `__kandeloPipe()`; build the `actions` list to
  `dup2` the child end onto 0/1/2 and `close` the parent ends in the child;
  `'ignore'` → `open('/dev/null')` action; `'inherit'` → `dup2` our 0/1/2; int →
  `dup2` that fd.
- Add `{op:'chdir', path: options.cwd}` when `cwd` is set; assemble `env` (default
  `process.env`); if `shell:true`, rewrite to `['/bin/sh','-c',cmd]`.
- Call `__kandeloSpawn`; set `child.pid`. Wire streams: `child.stdout`/`stderr`
  are `Readable`s pumped by a `__kandeloFdRead` loop (push chunks, `push(null)` on
  EOF); `child.stdin` is a `Writable` whose `_write` → `__kandeloFdWrite` and
  whose `_final`/`.end()` → `__kandeloFdClose` (**this delivers stdin EOF — the
  fix for the `-p` deadlock**).
- `__kandeloWaitPid(pid)` → emit `'exit'(code, signal)` then `'close'` after the
  stdio streams flush. `child.kill(sig='SIGTERM')` → `__kandeloKill`.
- `posix_spawn` failure → asynchronously emit `'error'` (Node semantics), and for
  `exec`/`execFile` surface it to the callback.
- `spawnSync`/`execSync`/`execFileSync` **stay on the working `popen` path** this
  phase (they are synchronous and functional); fix `spawnSync` to report a real
  `pid`/`signal` only if cheap. A `posix_spawn`-based synchronous drain is a
  documented follow-up.

## Error handling

| Situation | Behavior |
|---|---|
| `posix_spawn` fails (ENOENT, EACCES) | `spawn` returns a child that asynchronously emits `'error'` with `err.code`/`errno` (Node semantics); `exec` calls back with the error |
| child stdout/stderr read error | destroy that stream with the error; still reap the child |
| `kill` on a dead child | returns/raises `ESRCH` like Node (`child.kill` returns false) |
| `detached`/`uid`/`gid` requested | child spawns; the unimplemented attr is a documented boundary (posix-status.md), not a throw and not a silent success claim |
| EOF delivery | `child.stdin.end()` closes the write fd → sticky anonymous-pipe EOF → child's `read(0)` returns 0 |

## Testing

Guest tests via `runCentralizedProgram` (in-kernel), staging tiny helper
programs where needed:

1. **spawn + stdout capture**: spawn a program that writes known bytes to stdout;
   assert `child.stdout` `'data'` + `'exit'(0)` + `'close'`.
2. **stdin → EOF (the deadlock regression guard)**: spawn a `cat`-like child,
   `child.stdin.write("hi"); child.stdin.end()`; assert stdout echoes `"hi"` and
   the child **exits** (EOF delivered) rather than hanging.
3. **exit code + signal**: a child that `exit(3)` → `'exit'(3, null)`; a child
   killed via `child.kill('SIGKILL')` → `'exit'(null,'SIGKILL')`.
4. **stderr separation**: `stdio:['pipe','pipe','pipe']`, child writes to stderr;
   assert `child.stderr` receives it (today stderr is always empty).
5. **cwd**: spawn with `cwd:'/tmp'` a child that prints its cwd; assert `/tmp`.
6. **timer-drain guard**: `setTimeout(()=>log('T'),50)` fires and logs `T`
   (today it never fires).
7. **`claude -p` acceptance (throwaway)**: the `-p` hang is gone; init advances
   past the shell-out. Capture the next `-p` blocker as the Phase L seed.

Plus: all Phase A–J esm-probe cases stay green.

## Task decomposition (for the plan)

- **Task 1 — native seam + watch generalization + timer drain (C).** New patch:
  `__kandeloSpawn`/`__kandeloPipe`/`__kandeloFdRead`/`Write`/`Close`/
  `__kandeloWaitPid`/`__kandeloKill`; generalize the patch-0012 watch list to
  fds + child pids and extend keep-alive; wire `__kandeloRunDueTimers` into the
  loop. adapter.js delegation. A minimal guest test that calls the seam directly
  (spawn `echo`, read stdout, reap) — this is the independently-testable
  deliverable; folds into Task 2's node.wasm rebuild only if batched, else its
  own rebuild.
- **Task 2 — node-compat `child_process` rewrite + acceptance (JS).** Real
  `ChildProcess` on the primitives (stdio matrix, streams, exit/close, kill,
  error); `spawn`/`exec`/`execFile`; keep sync-on-popen. esm-probe cases 1–6;
  ONE node.wasm rebuild (batched with Task 1's C if sequenced together);
  throwaway `-p` acceptance capturing the Phase L seed; `posix-status.md`
  (async child_process supported; `detached`/`uid`/`gid` boundary; timers now
  live; sync-spawn-on-popen follow-up).

Note: Tasks 1 and 2 both require the ~35-min node.wasm rebuild, so the plan may
merge them into one build cycle (implement C + JS, single rebuild, then the
seam test + child_process tests + acceptance together) to avoid two 35-min
builds — the writing-plans step will decide the exact task/commit boundaries.
