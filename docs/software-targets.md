# Software Targets

Systems software to port to Kandelo, prioritized by POSIX depth and browser utility.

## POSIX Coverage Matrix

| Software | fork | exec | shmem | sem | signals | mmap | threads | sockets | pty | dlopen |
|----------|------|------|-------|-----|---------|------|---------|---------|-----|--------|
| PostgreSQL | heavy | ✓ | heavy | heavy | heavy | ✓ | ✓ | ✓ | — | ✓ |
| dash | heavy | heavy | — | — | heavy | — | — | — | ✓ | — |
| CPython | ✓ | ✓ | — | ✓ | ✓ | ✓ | heavy | ✓ | ✓ | heavy |
| Git | heavy | heavy | — | — | ✓ | heavy | — | — | — | — |
| Redis | ✓ | — | — | — | ✓ | ✓ | light | ✓ | — | ✓ |
| Node.js | ✓ | ✓ | — | — | ✓ | ✓ | heavy | heavy | ✓ | heavy |
| curl | — | — | — | — | ✓ | — | ✓ | heavy | — | — |

## Targets

### PostgreSQL
- **Status:** not started
- **Priority:** high
- **POSIX surface:** Fork-per-connection, SysV shared memory (shmget/shmat) or mmap MAP_SHARED, POSIX semaphores, select/poll event loop, signals for backend coordination, fcntl advisory locks
- **Browser value:** Full ACID SQL database
- **Kernel gaps:** SysV shared memory and semaphores are implemented (PR #146) but PostgreSQL's heavy fork-per-connection model will stress multi-process coordination harder than MariaDB's thread-per-connection model.
- **Build notes:** Large C codebase, autoconf-based. Needs libreadline or libedit for psql client. Server (postgres) is the main target.

### dash (POSIX shell)
- **Status:** done (PR #124)
- **Priority:** high
- **POSIX surface:** fork+exec for every command, pipes, process groups (setpgid), job control (SIGTSTP/SIGCONT/SIGTTIN/SIGTTOU), here-documents, command substitution via pipes, wait/waitpid, signal masking
- **Browser value:** Interactive terminal environment. Enables running shell scripts (configure, make) which unlocks self-hosting build tools.
- **Kernel gaps:** exec needs to work reliably. Job control signals (SIGTSTP etc.) and process groups need testing. pty support needed for interactive use.
- **Build notes:** Small C codebase (~15k lines), autoconf. Minimal dependencies. Good first target.

### CPython
- **Status:** done (PR #133) - CPython 3.13.3 REPL and script runner, browser UI image
- **Priority:** high
- **POSIX surface:** Threading, fork, signals, mmap, dlopen (extension modules), setjmp/longjmp, select, locale, regex
- **Browser value:** Python interpreter in the browser. Huge standalone appeal. Pyodide exists on Emscripten but a native POSIX build is a different proposition.
- **Kernel gaps:** dlopen for C extension modules, threading + fork interaction, locale support.
- **Build notes:** autoconf-based. Can disable many optional modules to start. Core interpreter has few dependencies. Full stdlib wants zlib, libffi, openssl, sqlite (several already built).

### Git
- **Status:** not started
- **Priority:** medium
- **POSIX surface:** Heavy fork+exec (spawns sub-commands for everything), mmap for packfiles, pipes for inter-process communication, file locking, signals
- **Browser value:** Niche but impressive. More importantly, forces exec to work well end-to-end.
- **Kernel gaps:** exec implementation needs to be solid. Many child processes spawned per operation.
- **Build notes:** Makefile-based (not autoconf). Needs zlib, optionally openssl and curl. Can build with NO_CURL, NO_OPENSSL for a minimal version.

### Redis
- **Status:** done (PR #132) — Redis 7.2 with 3 background threads, browser + Node.js demos
- **Priority:** medium
- **POSIX surface:** fork() for BGSAVE snapshots, epoll/select event loop, pipes for parent-child communication, signals, mmap for RDB loading
- **Browser value:** In-memory cache and pub/sub alongside the LAMP stack.
- **Kernel gaps:** Mostly covered. fork + event loop + signals are well-tested already.
- **Build notes:** Simple Makefile, minimal dependencies. Single-threaded core (threads only for background I/O in Redis 6+, can be disabled). Should be one of the easier builds.

### Node.js
- **Status:** not started
- **Priority:** medium
- **POSIX surface:** Threads (libuv thread pool), epoll/kqueue event loop, pipes, sockets, signals, mmap, dlopen (native addons), fork+exec (child_process), pty (for stdio)
- **Browser value:** JavaScript runtime in the browser. Enables running npm scripts, build tools (webpack, vite, tsc), and server-side JS frameworks.
- **Kernel gaps:** libuv's event loop needs solid epoll/poll. Thread pool (4+ threads by default) stresses clone/thread support. dlopen for native addons. child_process needs fork+exec.
- **Build notes:** GN or autoconf build system. V8 engine is the bulk of the build. Can start with a minimal build (--without-intl, --without-ssl, --without-inspector). libuv is the critical POSIX interface layer — if libuv works, most of Node.js works. Consider building libuv standalone first as a stepping stone.

### curl / libcurl
- **Status:** not started
- **Priority:** medium
- **POSIX surface:** Sockets, DNS (getaddrinfo), SSL/TLS, select/poll, SIGPIPE handling
- **Browser value:** HTTP client. Build dependency for many other programs.
- **Kernel gaps:** DNS resolution (getaddrinfo stub). Mostly socket work that's already done.
- **Build notes:** autoconf or CMake. Needs openssl (already built). Can start with --without-ssl for a minimal build.

## Completed

- nginx 1.24 — fork, sockets, signals, non-blocking I/O, SCM_RIGHTS
- PHP 8.4 (CLI + FPM) — fork, threads, sockets, file I/O, dlopen
- MariaDB 10.5 — threads, file I/O, sockets, signals (thread-per-connection)
- WordPress 6.7 — full LAMP stack integration test
- dash — fork+exec, pipes, process groups, signals
- GNU coreutils 9.6 — cat, cut, head, tail, sort, uniq, wc, tr, printf, etc.
- GNU grep 3.11 — regex, file I/O
- GNU sed 4.9 — stream editing
- Redis 7.2 — threads, sockets, signals, event loop
- CPython 3.13.3 — mmap, signals, fork, file I/O, REPL + script runner
- NetHack 3.6.7 — curses UI, DLB-packed data archive, /home/.nethack saves; shipped via the shell demo as a lazy archive
- Rust `std` (`wasm32-unknown-kandelo`) — generic Rust programs with full std: fs, args/env, time, HashMap, `std::thread`+`Mutex`, `std::net` TCP, `std::process` (fork+exec, instrumented). Built with `wasm32posix-cargo`; see `docs/rust-target.md`.
