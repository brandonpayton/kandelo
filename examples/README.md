# Kernel Examples

C programs demonstrating Kandelo kernel and SDK capabilities. Each can be
compiled with the SDK and run on the TypeScript host.

Package-specific demo launchers live under each package's
`packages/registry/<name>/demo/` directory. Package integration test harnesses
live under `packages/registry/<name>/test/`. Browser-facing demos live under
[`apps/browser-demos/`](../apps/browser-demos/).

## Building and Running

```bash
# Compile any example
wasm32posix-cc examples/hello.c -o hello.wasm

# Run it
npx tsx examples/run-example.ts hello
```

`run-example.ts` starts guests as root by default. Set `KERNEL_UID` and
`KERNEL_GID` to decimal values from 0 through 4294967294 when a test needs a
different initial user or group. The maximum unsigned 32-bit value is reserved
by the host protocol and is rejected rather than being mistaken for an ID.

The runner has two explicit filesystem modes. Its default `raw` mode preserves
the legacy direct host-filesystem behavior and accepts `KERNEL_CWD`.
`KANDELO_RUNNER_VFS=isolated` instead boots the canonical root image with
lifecycle-owned scratch storage and uses `/tmp` as the guest working directory.
Conformance harnesses may additionally provide one quiescent fixture directory
with `KANDELO_RUNNER_FIXTURE_ROOT`, a relative
`KANDELO_RUNNER_FIXTURE_CWD`, and an optional relative
`KANDELO_RUNNER_GUEST_PROGRAM`. The worker copies that tree under
`/run/kandelo-run` before readiness (a host-backed mount the in-kernel tmpfs
does not claim, so the fixture stays visible whether or not tmpfs owns the
scratch prefixes); the guest cannot mutate the source, and ambient host
executable lookup is disabled. These controls are runner plumbing, not guest
environment variables.

See [docs/sdk-guide.md](../docs/sdk-guide.md) for full SDK documentation.

## Programs

### Basics

| Example | Description |
|---------|-------------|
| [hello.c](hello.c) | Hello world — minimal printf test |
| [malloc.c](malloc.c) | Dynamic memory allocation via brk/mmap |
| [strings.c](strings.c) | String operations (string.h, ctype.h) |
| [math.c](math.c) | Number formatting and basic math |
| [snprintf.c](snprintf.c) | String formatting without I/O |
| [fprintf.c](fprintf.c) | Writing to stdout and stderr |

### Filesystem

| Example | Description |
|---------|-------------|
| [files.c](files.c) | File I/O — open, read, write, seek, stat |
| [dirs.c](dirs.c) | Directory operations — mkdir, readdir, rmdir |
| [flock_test.c](flock_test.c) | Advisory file locking via flock() |

### System

| Example | Description |
|---------|-------------|
| [environ.c](environ.c) | Process info and environment variables |
| [putenv_test.c](putenv_test.c) | setenv/getenv/putenv/unsetenv |
| [getaddrinfo_test.c](getaddrinfo_test.c) | DNS resolution via getaddrinfo() |
| [mmap_file_test.c](mmap_file_test.c) | Memory-mapped file I/O |
| [test-pthread.c](test-pthread.c) | Thread creation via clone() |
| [sysv_ipc_test.c](sysv_ipc_test.c) | SysV IPC (message queues, semaphores) |

### Browser Demos

The `apps/browser-demos/` app contains interactive demos running real software
in the browser via Vite:

```bash
cd apps/browser-demos
npm install
npx vite --port 5198
```

| Demo | URL path | Software |
|------|----------|----------|
| Simple Programs | `/` | C example programs |
| Shell | `/pages/shell/` | dash + GNU coreutils |
| Python | `/pages/python/` | CPython 3.13 REPL |
| PHP CLI | `/pages/php/` | PHP 8.4 scripts |
| nginx | `/pages/nginx/` | Static file serving |
| nginx + PHP-FPM | `/pages/nginx-php/` | FastCGI integration |
| MariaDB | `/pages/mariadb/` | SQL database (5 threads) |
| Redis | `/pages/redis/` | In-memory store (3 threads) |
| WordPress | `/pages/wordpress/` | nginx + PHP-FPM + SQLite |
| LAMP | `/pages/lamp/` | MariaDB + nginx + PHP-FPM + WordPress |

Live at: [Kandelo browser demos](https://automattic.github.io/kandelo/)

See [docs/porting-guide.md](../docs/porting-guide.md) for how to create new demos.

### Ported Software

Build scripts for real-world software are in `packages/registry/`. Runnable
package demos live in `packages/registry/<name>/demo/`, and package integration
test harnesses live in `packages/registry/<name>/test/`.

| Software | Build script | Binary output |
|----------|-------------|---------------|
| dash 0.5.12 | `packages/registry/dash/build-dash.sh` | `packages/registry/dash/bin/dash.wasm` |
| GNU coreutils 9.6 | `packages/registry/coreutils/build-coreutils.sh` | `packages/registry/coreutils/bin/coreutils.wasm` |
| GNU grep 3.11 | `packages/registry/grep/build-grep.sh` | `packages/registry/grep/bin/grep.wasm` |
| GNU sed 4.9 | `packages/registry/sed/build-sed.sh` | `packages/registry/sed/bin/sed.wasm` |
| PHP 8.4 | `packages/registry/php/build-php.sh` | `packages/registry/php/bin/php.wasm`, `php-fpm.wasm` |
| MariaDB 10.5 | `packages/registry/mariadb/build-mariadb.sh` | `packages/registry/mariadb/bin/mariadbd.wasm` |
| Redis 7.2 | `packages/registry/redis/build-redis.sh` | `packages/registry/redis/bin/redis-server.wasm` |
| CPython 3.13 | `packages/registry/cpython/build-cpython.sh` | `packages/registry/cpython/bin/python.wasm` |
| nginx 1.24 | `packages/registry/nginx/build-nginx.sh` | `packages/registry/nginx/bin/nginx.wasm` |
| SQLite | `packages/registry/sqlite/build-sqlite.sh` | (library, linked into PHP) |
| zlib | `packages/registry/zlib/build-zlib.sh` | (library, linked into PHP) |
| libxml2 | `packages/registry/libxml2/build-libxml2.sh` | (library, linked into PHP) |
| OpenSSL | `packages/registry/openssl/build-openssl.sh` | (library, linked into PHP) |

## Pre-compiled Binaries

Most examples include pre-compiled `.wasm` files so you can run them without the SDK installed.
