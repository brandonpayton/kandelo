#!/usr/bin/env bash
#
# Unified build, run, and test script for kandelo.
#
# Usage:
#   ./run.sh build [target...]    Build specific targets (or all)
#   ./run.sh rebuild [target...]  Force-rebuild (clean + build)
#   ./run.sh clean [target...]    Remove build artifacts
#   ./run.sh local-build [--json] Build all local SourceOnly VFS products
#   ./run.sh run <example> [args] Run a Node.js example
#   ./run.sh prepare-browser      Build local SourceOnly browser assets
#   ./run.sh browser [args]       Start the Vite browser dev server
#   ./run.sh list                 Show available targets and examples
#   ./run.sh test [suite...]      Run test suites
#
# Top-level flags (recognized anywhere in the argument list):
#   --already-materialized        Retired browser selection mode; rejected by
#                                  browser commands.
#   --source-rootfs-shell         Retired browser selection mode; rejected by
#                                  browser commands.
#   --pr-staging                  Use the current PR's staging binary index for
#                                  fetch/package commands. Browser rejects it.
#
# Environment:
#   KANDELO_SOURCE_CACHE_ROOT     Absolute path to this worktree's own
#                                 SourceOnly build cache. Unset (default) shares
#                                 the machine-wide cache at
#                                 $HOME/.cache/kandelo/source-only, so identical
#                                 inputs build once and are reused across
#                                 worktrees. Set it to isolate a worktree whose
#                                 in-progress change alters cached artifact
#                                 bytes. See docs/package-management.md.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"

# pkg_xtask_bin freshens the release xtask binary exactly once per `./run.sh`
# invocation and records that it did so with this marker file. The name is a
# fresh random token per invocation (`mktemp -u` only generates an unused
# name; pkg_xtask_bin creates the file itself after a successful build). A
# random name — not one keyed by `$$` — is what makes a leaked marker inert:
# the EXIT trap below does not fire on the many `exec`-terminated command
# paths (cmd_run's `exec npx tsx …`, cmd_browser's `exec npx vite`, the
# nginx/mariadb/redis/wordpress/lamp/erlang/dlopen launches), so a marker can
# leak. Keyed by `$$` (a reusable PID), a later invocation the OS assigned the
# same PID — after an xtask source edit — would find the leaked marker and
# skip its rebuild, silently running stale orchestration. With a unique random
# name no future invocation ever looks for, a leaked marker can never be
# resurrected by PID reuse. `$(...)` command-substitution subshells inherit
# this parent global, so every call site sees the same marker path.
# `|| true`: this is a bare top-level command substitution under
# `set -euo pipefail`. Without the guard, a failing `mktemp` would abort the
# whole script here, before argument dispatch. An empty marker path is safe —
# `[ -f "" ]` is false, so pkg_xtask_bin simply always rebuilds that run (no
# memoization, no staleness).
KANDELO_XTASK_FRESH_MARKER="$(mktemp -u "${TMPDIR:-/tmp}/kandelo-xtask-fresh.XXXXXX")" || true
# Host triple (e.g. aarch64-apple-darwin) for the xtask build target, derived
# at most once per invocation. Memoized here so a marker-hit pkg_xtask_bin
# call does not re-run `rustc -vV` on every lookup, and so a transient rustc
# failure cannot fail a cache-hit call.
# `|| true`: `rustc` is legitimately absent for a bare `./run.sh <cmd>` run
# before entering the dev shell (pkg_xtask_bin's KANDELO_DEV_SHELL_TOOL_PATH
# branch exists for exactly this). Under `set -euo pipefail` the pipeline's
# exit 127 would otherwise `errexit`-abort the entire script here, before
# argument dispatch, breaking every subcommand (e.g. `./run.sh list`). Failing
# soft to an empty string restores the old lazy behavior: pkg_xtask_bin's
# `[ -z "$host" ] && return 1` guard then fires its normal caller error.
KANDELO_XTASK_HOST_TRIPLE="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')" || true

# Best-effort cleanup for the freshness marker. Some subcommands
# (cmd_local_build, the source-rootfs-shell browser path) install their own
# EXIT trap and later clear it with `trap - EXIT INT TERM`, which would
# clobber this one for the remainder of their run; and `exec`-terminated paths
# never fire it at all. Both are harmless now: the marker has a unique random
# name, so a lingering file cannot make any other `./run.sh` invocation skip
# its own freshness check.
trap 'rm -f -- "$KANDELO_XTASK_FRESH_MARKER"' EXIT

BROWSER_MEMORY64_FIXTURES_REPO_ROOT="$REPO_ROOT"
BROWSER_MEMORY64_FIXTURES_MANIFEST="$REPO_ROOT/scripts/browser-memory64-example-fixtures.txt"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/browser-memory64-example-fixtures.sh"

# Activate the worktree-local SDK toolchain (no global npm link required).
# Build scripts also source this directly; sourcing here makes the tools
# available to anything `run.sh` shells out to (e.g. `bash run.sh build_X`).
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

# ─── Colors ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && command -v tput &>/dev/null && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); CYAN=$(tput setaf 6)
    RED=$(tput setaf 1); BOLD=$(tput bold); RESET=$(tput sgr0)
else
    GREEN=""; YELLOW=""; CYAN=""; RED=""; BOLD=""; RESET=""
fi

info()  { echo "${GREEN}[OK]${RESET} $*"; }
warn()  { echo "${YELLOW}[>>]${RESET} $*"; }
err()   { echo "${RED}[!!]${RESET} $*" >&2; }
step()  { echo "${CYAN}${BOLD}=== $* ===${RESET}"; }

# ─── Top-level flag parsing ──────────────────────────────────────────────────
#
# Scrub top-level flags from $@ and turn them into env vars so downstream
# fetch/build commands inherit them. Browser commands reject retired binary
# selection modes and always use the local SourceOnly graph.
ALREADY_MATERIALIZED=0
SOURCE_ROOTFS_SHELL=0
USE_PR_STAGING=0
NEW_ARGS=()
for a in "$@"; do
    case "$a" in
        --already-materialized)
            ALREADY_MATERIALIZED=1
            ;;
        --source-rootfs-shell)
            SOURCE_ROOTFS_SHELL=1
            ;;
        --pr-staging)
            USE_PR_STAGING=1
            ;;
        *)
            NEW_ARGS+=("$a")
            ;;
    esac
done
set -- "${NEW_ARGS[@]+"${NEW_ARGS[@]}"}"
if [ "${WASM_POSIX_ALREADY_MATERIALIZED:-0}" = "1" ]; then
    ALREADY_MATERIALIZED=1
fi
CI_BROWSER_SOURCE_AUTHORITY="${WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY:-}"
unset WASM_POSIX_CI_BROWSER_SOURCE_AUTHORITY
export WASM_POSIX_ALREADY_MATERIALIZED=$ALREADY_MATERIALIZED
export WASM_POSIX_SOURCE_ROOTFS_SHELL=$SOURCE_ROOTFS_SHELL
if [ "${WASM_POSIX_USE_PR_STAGING:-0}" = "1" ]; then
    USE_PR_STAGING=1
fi
export WASM_POSIX_USE_PR_STAGING=$USE_PR_STAGING

case "${1:-}" in
    browser|prepare-browser)
        if [ "$ALREADY_MATERIALIZED" -eq 1 ] ||
            [ "$SOURCE_ROOTFS_SHELL" -eq 1 ] ||
            [ "$USE_PR_STAGING" -eq 1 ] ||
            [ -n "$CI_BROWSER_SOURCE_AUTHORITY" ]; then
            err "browser commands use local SourceOnly builds; legacy binary-selection modes are not supported."
            exit 2
        fi
        ;;
esac

if [ "$SOURCE_ROOTFS_SHELL" -eq 1 ]; then
    [ "$#" -eq 1 ] && [ "${1:-}" = "prepare-browser" ] || {
        err "--source-rootfs-shell is internal to the GitHub Pages prepare-browser job."
        exit 2
    }
    if [ "$ALREADY_MATERIALIZED" -eq 1 ] ||
        [ "$USE_PR_STAGING" -eq 1 ]; then
        err "--source-rootfs-shell cannot combine with already-materialized or PR-staging modes."
        exit 2
    fi
fi

validate_ci_browser_source_authority() {
    [ -n "$CI_BROWSER_SOURCE_AUTHORITY" ] || return 0
    if [ "$CI_BROWSER_SOURCE_AUTHORITY" != source-rootfs-mirror-state-v1 ]; then
        err "Unknown internal browser source authority."
        return 2
    fi
    if [ "$#" -ne 1 ] || [ "${1:-}" != prepare-browser ] ||
        [ "$ALREADY_MATERIALIZED" -ne 1 ] ||
        [ "$SOURCE_ROOTFS_SHELL" -ne 0 ] ||
        [ "$USE_PR_STAGING" -ne 0 ]; then
        err "Internal browser source authority requires isolated CI preparation."
        return 2
    fi
}
validate_ci_browser_source_authority "$@" || exit $?

# ─── Artifact checks ─────────────────────────────────────────────────────────

# `has_resolvable <rel>` is true when the binary resolves via
# `local-binaries/` or `binaries/`. Used to treat fetched binaries as
# "already built" so build_target skips.
has_resolvable() {
    "$REPO_ROOT/scripts/resolve-binary.sh" "$1" >/dev/null 2>&1
}

KERNEL_REQUIRED_EXPORTS=(
    __abi_version
    kernel_alloc_scratch
    kernel_blocking_retry_release
    kernel_blocking_retry_token
    kernel_commit_process_exit
    kernel_create_process
    kernel_create_process_with_stdio
    kernel_dequeue_signal
    kernel_exec_commit
    kernel_exec_target_cancel
    kernel_exec_target_prepare
    kernel_exec_target_read
    kernel_exec_target_size
    kernel_fork_process
    kernel_get_cwd
    kernel_get_dirfd_path
    kernel_get_fd_path
    kernel_get_parent_pid
    kernel_get_process_exit_signal
    kernel_get_process_state
    kernel_get_socket_timeout_ms
    kernel_handle_channel
    kernel_has_sa_nocldstop
    kernel_host_adapter_manifest_len
    kernel_host_adapter_manifest_ptr
    kernel_ipc_shm_lookup_mapping_for_task
    kernel_ipc_shm_record_mapping_for_process
    kernel_ipc_shm_record_mapping_for_task
    kernel_ipc_shmat_for_process
    kernel_ipc_shmat_for_task
    kernel_ipc_shmdt_addr_for_process
    kernel_ipc_shmdt_addr_for_task
    kernel_ipc_shmdt_for_process
    kernel_ipc_shmdt_for_task
    kernel_is_fd_nonblock
    kernel_mark_process_signaled
    kernel_mq_descriptor_msgsize
    kernel_msqid_ds_bytes
    kernel_pcm_claim_transport
    kernel_pcm_clock_update
    kernel_pcm_reconcile
    kernel_pcm_transport_len
    kernel_pcm_transport_ptr
    kernel_pick_signal_target_tid
    kernel_pick_tcp_listener_target
    kernel_pipe_has_readers
    kernel_posix_timer_fire
    kernel_process_metadata_begin
    kernel_process_metadata_cancel
    kernel_process_metadata_commit
    kernel_process_metadata_stage
    kernel_process_secure_exec
    kernel_publish_spawn_child
    kernel_reap_exited_child
    kernel_remove_process
    kernel_semctl_array_bytes
    kernel_semid_ds_bytes
    kernel_set_current_tid
    kernel_set_cwd
    kernel_shmid_ds_bytes
    kernel_spawn_exec_commit
    kernel_spawn_exec_target_prepare
    kernel_spawn_process
    kernel_spawn_reserved_process
    kernel_spawn_scratch_begin
    kernel_spawn_scratch_cancel
    kernel_spawn_scratch_capacity
    kernel_spawn_scratch_pointer
    kernel_spawn_scratch_retained_capacity
    kernel_take_process_timer_cleanup
    kernel_thread_exit
    kernel_thread_has_deliverable
    kernel_transfer_channel_execute
    kernel_transfer_io_execute
    kernel_transfer_scratch_begin
    kernel_transfer_scratch_cancel
    kernel_transfer_scratch_capacity
    kernel_transfer_scratch_pointer
    kernel_validate_task
    kernel_wait_child_poll
)

has_valid_kernel_file() {
    local path="$1"
    local current_abi
    [ -f "$path" ] || return 1
    current_abi="$(wasm_current_abi_version "$REPO_ROOT" || true)"
    ! wasm_has_legacy_asyncify "$path" &&
        ! wasm_has_stale_abi "$path" "$current_abi" &&
        ! wasm_has_missing_exports "$path" "${KERNEL_REQUIRED_EXPORTS[@]}" &&
        wasm_require_target_aware_exec_authority "$path" >/dev/null 2>&1
}

# pkg_xtask_bin: build xtask once (lazy) and return the binary path so
# repeated `pkg_has_output` calls don't pay cargo's setup cost on each
# call (~50ms × 40 has_* lookups in cmd_status = a real delay).
# pkg_xtask_bin: freshen the release xtask binary exactly ONCE per `./run.sh`
# invocation, then hand back its path.
#
# Freshness (not just "does a binary exist") matters here: this now backs
# the real bootstrap/build path (`bootstrap_target`), not just a peripheral
# build-deps helper, so a binary compiled before the most recent
# `tools/xtask/src/*.rs` edit must not be silently reused.
#
# "Once per invocation" cannot be a shell variable: every caller invokes
# this via command substitution (`xtask=$(pkg_xtask_bin)`), and `$(...)`
# always forks a subshell in bash — any assignment to a global variable
# inside the function is discarded when that subshell exits, so a plain
# `PKG_XTASK_FRESH=1` set here would never be visible to the next call.
# Freshness has to be recorded as real filesystem state instead: the
# `KANDELO_XTASK_FRESH_MARKER` file computed once at the top of this file.
# Reading that inherited parent global inside a `$(...)` subshell works fine
# (unlike writing one out); its unique random name makes a leaked marker inert
# against PID reuse. See the definition near the top of this file for why the
# name is random rather than keyed by `$$`.
pkg_xtask_bin() {
    local host="$KANDELO_XTASK_HOST_TRIPLE"
    if [ -z "$host" ]; then
        return 1
    fi
    local bin="$REPO_ROOT/target/$host/release/xtask"
    local marker="$KANDELO_XTASK_FRESH_MARKER"
    if [ ! -f "$marker" ]; then
        # Always run `cargo build`, not just when the binary is absent:
        # cargo's own incremental check is what gives us the freshness
        # guarantee (a fast no-op when tools/xtask/src is unchanged, a real
        # rebuild/relink when it isn't) — the same guarantee `cargo run`
        # gave the old per-call `bootstrap_target` before it was switched to
        # this cached-path helper.
        if [ -n "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ]; then
            # Consumer jobs already run inside the declared dev shell, where
            # `nix` is intentionally absent. Build directly in that shell if
            # a caller did not provide the prepared xtask binary.
            (cd "$REPO_ROOT" && \
                cargo build --release -p xtask --target "$host" --quiet) >&2 || return 1
        else
            (cd "$REPO_ROOT" && bash scripts/dev-shell.sh \
                cargo build --release -p xtask --target "$host" --quiet) >&2 || return 1
        fi
        [ -x "$bin" ] || return 1
        : > "$marker"
    fi
    echo "$bin"
}

# pkg_output_rel <pkg-name> <wasm-basename> [arch]
#
# Print the package system's canonical path below programs/<arch>/ for one
# declared output. Keep local materialization and cleanup on this same metadata
# path so output layout changes cannot strand stale artifacts.
pkg_output_rel() {
    local pkg=$1
    local wasm=$2
    local arch=${3:-wasm32}
    local xtask
    xtask=$(pkg_xtask_bin) || return 1
    "$xtask" build-deps --arch "$arch" output-path "$pkg" "$wasm" 2>/dev/null
}

# pkg_local_output_path <pkg-name> <wasm-basename> [arch]
pkg_local_output_path() {
    local pkg=$1
    local wasm=$2
    local arch=${3:-wasm32}
    local rel
    rel=$(pkg_output_rel "$pkg" "$wasm" "$arch") || return 1
    case "$rel" in
        ""|/*|../*|*/../*|*/..)
            err "Package resolver returned an unsafe output path for $pkg: $rel"
            return 1
            ;;
    esac
    printf '%s\n' "$REPO_ROOT/local-binaries/programs/$arch/$rel"
}

pkg_remove_local_output() {
    local output
    output=$(pkg_local_output_path "$@") || return 1
    rm -f -- "$output"
}

# pkg_has_output <pkg-name> <wasm-basename> [arch]
#
# True when the package's named output is resolvable via the package
# system — i.e. xtask's `build-deps output-path` returns its rel path
# under `programs/<arch>/` AND that path resolves through `binaries/`
# or `local-binaries/`. This is the single source of truth for "is
# this package built?" — replaces ~30 hand-coded has_<pkg> checks
# that hardcoded the flat-vs-nested layout convention and silently
# drifted when a package moved from scalar to package-directory layout
# (the Erlang build exposed this bug). Layout decisions live in
# `output_dest_rel_for` only.
#
# The wasm-basename arg is the file listed in `[[outputs]].wasm`
# (e.g. `python.wasm`, `mariadbd.wasm`), NOT the output `name` field.
# Arch defaults to wasm32; pass wasm64 for the per-arch variants.
pkg_has_output() {
    local pkg=$1
    local wasm=$2
    local arch=${3:-wasm32}
    local rel
    rel=$(pkg_output_rel "$pkg" "$wasm" "$arch") || return 1
    if [ "$arch" = "wasm32" ]; then
        # `has_resolvable programs/<x>` injects `wasm32/` per the
        # default-arch shim (matches host/src/binary-resolver.ts). No
        # explicit arch segment needed.
        has_resolvable "programs/$rel"
    else
        has_resolvable "programs/$arch/$rel"
    fi
}

has_browser_memory64_example_fixtures() {
    local output
    local outputs
    outputs="$(browser_memory64_fixture_outputs)" || return 1
    while IFS= read -r output; do
        [ -f "$REPO_ROOT/$output" ] || return 1
    done <<< "$outputs"
}
has_programs() {
    has_resolvable programs/fork-exec.wasm &&
    has_resolvable programs/fbtest.wasm &&
    [ -f "$REPO_ROOT/examples/pthread_channel_reuse_test.wasm" ] &&
    [ -f "$REPO_ROOT/examples/wait_lifecycle_test.wasm" ] &&
    has_browser_memory64_example_fixtures &&
    [ -f "$REPO_ROOT/benchmarks/wasm/pipe-throughput.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/file-throughput.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/syscall-latency.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/fork-bench.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/clone-bench.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/spawn-bench.wasm" ] &&
    [ -f "$REPO_ROOT/benchmarks/wasm/hello.wasm" ]
}

# Package-system entries: layout derived from package.toml's
# `[[outputs]]` via `xtask build-deps output-path`. Source-tree
# fallbacks left in place for the developer-hand-built case.
has_nginx()         { pkg_has_output nginx nginx.wasm || [ -f "$REPO_ROOT/packages/registry/nginx/nginx.wasm" ]; }
has_php()           { pkg_has_output php php.wasm || [ -f "$REPO_ROOT/packages/registry/php/php-src/sapi/cli/php" ]; }
has_php_fpm()       { pkg_has_output php php-fpm.wasm || [ -f "$REPO_ROOT/packages/registry/php/php-src/sapi/fpm/php-fpm" ]; }
has_mariadb()       { pkg_has_output mariadb mariadbd.wasm || [ -f "$REPO_ROOT/packages/registry/mariadb/mariadb-install/bin/mariadbd.wasm" ]; }
has_mariadb64()     { pkg_has_output mariadb mariadbd.wasm wasm64 || [ -f "$REPO_ROOT/packages/registry/mariadb/mariadb-install-64/bin/mariadbd.wasm" ]; }
has_mariadb_vfs()   { pkg_has_output mariadb-vfs mariadb-vfs.vfs.zst; }
has_mariadb64_vfs() { pkg_has_output mariadb-vfs mariadb-vfs.vfs.zst wasm64; }
has_wordpress()     { [ -f "$REPO_ROOT/packages/registry/wordpress/wordpress/wp-settings.php" ]; }
has_wp_vfs()        { pkg_has_output wordpress wordpress.vfs.zst; }
has_dash()          { pkg_has_output dash dash.wasm || [ -f "$REPO_ROOT/packages/registry/dash/bin/dash.wasm" ]; }
has_bash()          { pkg_has_output bash bash.wasm || [ -f "$REPO_ROOT/packages/registry/bash/bin/bash.wasm" ]; }
has_coreutils()     { pkg_has_output coreutils coreutils.wasm || [ -f "$REPO_ROOT/packages/registry/coreutils/bin/coreutils.wasm" ]; }
has_grep()          { pkg_has_output grep grep.wasm || [ -f "$REPO_ROOT/packages/registry/grep/bin/grep.wasm" ]; }
has_sed()           { pkg_has_output sed sed.wasm || [ -f "$REPO_ROOT/packages/registry/sed/bin/sed.wasm" ]; }
has_redis()         { pkg_has_output redis redis-server.wasm || [ -f "$REPO_ROOT/packages/registry/redis/bin/redis-server.wasm" ]; }
has_dinit()         { pkg_has_output dinit dinit.wasm || [ -f "$REPO_ROOT/packages/registry/dinit/bin/dinit.wasm" ]; }
has_msmtpd()        { pkg_has_output msmtpd msmtpd.wasm || [ -f "$REPO_ROOT/packages/registry/msmtpd/bin/msmtpd.wasm" ]; }
has_cpython()       { pkg_has_output cpython python.wasm || [ -f "$REPO_ROOT/packages/registry/cpython/bin/python.wasm" ]; }
has_python_vfs()    { pkg_has_output python-vfs python-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/python.vfs.zst" ]; }
has_perl_vfs()      { pkg_has_output perl-vfs perl-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/perl.vfs.zst" ]; }
has_shell_vfs()     {
    pkg_has_output shell shell.vfs.zst
}
has_node()          { pkg_has_output node node.wasm; }
has_spidermonkey_node() { pkg_has_output spidermonkey-node node.wasm || [ -f "$REPO_ROOT/packages/registry/spidermonkey-node/bin/node.wasm" ]; }
has_node_vfs()      { pkg_has_output node-vfs node-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" ]; }
has_erlang()        { pkg_has_output erlang erlang.wasm || [ -f "$REPO_ROOT/packages/registry/erlang/bin/beam.wasm" ]; }
has_erlang_vfs()    { pkg_has_output erlang-vfs erlang-vfs.vfs.zst || [ -f "$REPO_ROOT/apps/browser-demos/public/erlang.vfs.zst" ]; }
has_lamp_vfs()      { pkg_has_output lamp lamp.vfs.zst; }
has_mariadb_test_vfs() { pkg_has_output mariadb-test mariadb-test.vfs.zst; }
has_bc()            { pkg_has_output bc bc.wasm || [ -f "$REPO_ROOT/packages/registry/bc/bin/bc.wasm" ]; }
has_file()          { pkg_has_output file file.wasm || [ -f "$REPO_ROOT/packages/registry/file/bin/file.wasm" ]; }
has_less()          { pkg_has_output less less.wasm || [ -f "$REPO_ROOT/packages/registry/less/bin/less.wasm" ]; }
has_m4()            { pkg_has_output m4 m4.wasm || [ -f "$REPO_ROOT/packages/registry/m4/bin/m4.wasm" ]; }
has_make()          { pkg_has_output make make.wasm || [ -f "$REPO_ROOT/packages/registry/make/bin/make.wasm" ]; }
has_tar()           { pkg_has_output tar tar.wasm || [ -f "$REPO_ROOT/packages/registry/tar/bin/tar.wasm" ]; }
has_curl()          { pkg_has_output curl curl.wasm || [ -f "$REPO_ROOT/packages/registry/curl/bin/curl.wasm" ]; }
has_wget()          { pkg_has_output wget wget.wasm || [ -f "$REPO_ROOT/packages/registry/wget/bin/wget.wasm" ]; }
has_gzip()          { pkg_has_output gzip gzip.wasm || [ -f "$REPO_ROOT/packages/registry/gzip/bin/gzip.wasm" ]; }
has_bzip2()         { pkg_has_output bzip2 bzip2.wasm || [ -f "$REPO_ROOT/packages/registry/bzip2/bin/bzip2.wasm" ]; }
has_xz()            { pkg_has_output xz xz.wasm || [ -f "$REPO_ROOT/packages/registry/xz/bin/xz.wasm" ]; }
has_zstd()          { pkg_has_output zstd zstd.wasm || [ -f "$REPO_ROOT/packages/registry/zstd/bin/zstd.wasm" ]; }
has_zip()           { pkg_has_output zip zip.wasm || [ -f "$REPO_ROOT/packages/registry/zip/bin/zip.wasm" ]; }
has_lsof()          { pkg_has_output lsof lsof.wasm || [ -f "$REPO_ROOT/packages/registry/lsof/lsof.wasm" ]; }
has_unzip()         { pkg_has_output unzip unzip.wasm || [ -f "$REPO_ROOT/packages/registry/unzip/bin/unzip.wasm" ]; }
has_nano()          { pkg_has_output nano nano.wasm || [ -f "$REPO_ROOT/packages/registry/nano/bin/nano.wasm" ]; }
has_nethack()       { pkg_has_output nethack nethack.wasm || [ -f "$REPO_ROOT/packages/registry/nethack/bin/nethack.wasm" ]; }
has_fbdoom()        { pkg_has_output fbdoom fbdoom.wasm || [ -f "$REPO_ROOT/packages/registry/fbdoom/fbdoom.wasm" ]; }
has_vim()           { pkg_has_output vim vim.wasm || [ -f "$REPO_ROOT/packages/registry/vim/bin/vim.wasm" ]; }
has_git()           { pkg_has_output git git.wasm || [ -f "$REPO_ROOT/packages/registry/git/bin/git.wasm" ]; }
has_perl()          { pkg_has_output perl perl.wasm || [ -f "$REPO_ROOT/packages/registry/perl/bin/perl.wasm" ]; }
has_ruby()          { pkg_has_output ruby ruby.wasm || [ -f "$REPO_ROOT/packages/registry/ruby/bin/ruby.wasm" ]; }
has_texlive()       { pkg_has_output texlive pdftex.wasm || [ -f "$REPO_ROOT/packages/registry/texlive/bin/pdftex.wasm" ]; }
has_texlive_vfs()   { pkg_has_output texlive texlive-bundle.json || [ -f "$REPO_ROOT/apps/browser-demos/public/texlive-bundle.json" ]; }

# Non-package targets — these live outside the package system; their
# layout is hand-rolled and doesn't go through `output-path`.
has_nginx_vfs()     { has_resolvable programs/nginx-vfs.vfs.zst; }
has_redis_vfs()     { has_resolvable programs/redis-vfs.vfs.zst; }
has_nginx_php_vfs() { has_resolvable programs/nginx-php-vfs.vfs.zst; }
has_ncurses()       { pkg_has_output ncurses clear.wasm && pkg_has_output ncurses tic.wasm && pkg_has_output ncurses tput.wasm; }
has_zlib()          { [ -f "$REPO_ROOT/sysroot/lib/libz.a" ] && [ -f "$REPO_ROOT/sysroot/include/zlib.h" ]; }
has_openssl()       { [ -f "$REPO_ROOT/sysroot/lib/libssl.a" ] && [ -f "$REPO_ROOT/sysroot/lib/libcrypto.a" ] && [ -f "$REPO_ROOT/sysroot/include/openssl/ssl.h" ]; }
has_libcurl()       { [ -f "$REPO_ROOT/sysroot/lib/libcurl.a" ] && [ -f "$REPO_ROOT/sysroot/include/curl/curl.h" ]; }
has_vim_zip()       { has_resolvable programs/vim.zip || [ -f "$REPO_ROOT/apps/browser-demos/public/vim.zip" ]; }
has_nethack_zip()   { has_resolvable programs/nethack.zip || [ -f "$REPO_ROOT/apps/browser-demos/public/nethack.zip" ]; }
has_dlopen()        { [ -f "$REPO_ROOT/examples/dlopen/hello-lib.so" ] && \
                      [ -f "$REPO_ROOT/examples/dlopen/main.wasm" ]; }

# ─── Need functions (ensure dependency is built) ─────────────────────────────
#
# Every need_* below (except need_node_modules, a root npm concern with no
# build artifact) is a thin delegator onto `xtask bootstrap <target>`. The
# freshness decision — is the kernel's ABI current, is a package's content
# unchanged, does the sysroot need a full rebuild or just a header resync —
# lives in the local-build engine / xtask, not here; see
# docs/agent-guidance/packages-and-builds.md.

# bootstrap_target <target> [xtask-bootstrap-args...]: run `xtask bootstrap
# <target>` inside the repository dev shell. This is the one front door every
# need_* delegator and the simple build_<pkg> delegators call through.
#
# Uses `pkg_xtask_bin` (the same lazy-build-once release binary this file
# already uses for `build-deps`/`output-metadata` calls) instead of
# `scripts/setup.sh`'s `cargo run -p xtask -- bootstrap ...`: a composite
# build_<pkg> (e.g. build_wp_vfs) fans out into several of these calls in one
# `./run.sh` invocation, and `cargo run` re-pays its own incremental-build
# check (a debug build/relink, not just a no-op) on every single one of them.
# Building the release binary once and invoking it directly removes that
# repeated cost; the dev shell still has to be (re-)entered per call so the
# invoked xtask process — and the package build scripts it shells out to —
# see LLVM_BIN/wasm{32,64}posix-cc/etc. on PATH.
bootstrap_target() {
    local target="$1"; shift
    local xtask
    xtask="$(pkg_xtask_bin)" || {
        err "bootstrap_target $target: could not build xtask"
        return 1
    }
    bash "$REPO_ROOT/scripts/dev-shell.sh" "$xtask" bootstrap "$target" "$@"
}

need_kernel() {
    bootstrap_target kernel
}

need_sysroot() {
    bootstrap_target sysroot
}

need_sysroot64() {
    bootstrap_target sysroot64
}

need_sdk() {
    # `xtask bootstrap sdk` ensures the sysroot first, then still errors if
    # sdk/bin/wasm32posix-cc isn't a working symlink after that — the SDK
    # wrappers being missing or broken isn't something a rebuild can fix.
    bootstrap_target sdk
}

need_host() {
    bootstrap_target host
}

need_rootfs() {
    bootstrap_target rootfs
}

need_fork_instrument() {
    bootstrap_target fork-instrument
}

need_node_modules() {
    if [ ! -d "$REPO_ROOT/node_modules" ]; then
        warn "Installing root npm dependencies"
        cd "$REPO_ROOT" && npm install --prefer-offline
    fi
}

# ─── Build targets ────────────────────────────────────────────────────────────

build_kernel() {
    need_kernel
}

build_sysroot() {
    need_sysroot
}

build_sysroot64() {
    need_sysroot64
}

build_sdk() {
    need_sdk
}

build_host() {
    need_host
}

build_rootfs() {
    need_rootfs
}

build_programs() {
    if has_programs; then
        info "programs"
        return
    fi
    need_kernel
    need_sysroot
    # The owned browser wait-lifecycle fixture exercises the memory64 ABI.
    need_sysroot64
    if ! has_programs; then
        step "Building programs"
        bash "$REPO_ROOT/scripts/build-programs.sh"
        info "Programs built"
    else
        info "Programs"
    fi
}

build_nginx() {
    bootstrap_target nginx
}

build_php() {
    bootstrap_target php
}

build_php_fpm() {
    # PHP-FPM is a second output of the same "php" package node (one build
    # produces both the CLI and the FPM SAPI); there is no separate
    # "php-fpm" package to select.
    bootstrap_target php
}

build_mariadb() {
    bootstrap_target mariadb
}

build_mariadb64() {
    bootstrap_target mariadb64
}

build_mariadb_vfs() {
    # NOT folded: "mariadb-vfs" is an `[[exclusions]]` entry in
    # packages/sets/local-supported.toml ("dormant browser product") — a
    # pre-existing product decision predating this stage, not an engine
    # limitation (its build script and
    # images/vfs/products/browser-mariadb-wasm32.toml manifest already exist
    # and validate fine; see
    # run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries in
    # tools/xtask/src/local_build.rs). Reactivating it is out of scope here.
    if has_mariadb_vfs; then
        info "MariaDB VFS image (wasm32)"
        return
    fi
    build_mariadb
    build_dash
    step "Building MariaDB VFS image (wasm32)"
    # Delegate to the package-system wrapper so install_local_binary
    # populates local-binaries/programs/wasm32/mariadb-vfs.vfs.zst (the
    # path the @binaries/ Vite alias resolves against).
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        bash "$REPO_ROOT/packages/registry/mariadb-vfs/build-mariadb-vfs.sh"
    info "MariaDB VFS image (wasm32) built"
}

build_mariadb64_vfs() {
    # NOT folded: same "mariadb-vfs" exclusion as build_mariadb_vfs above
    # (this is its wasm64 arch variant of the same excluded package).
    if has_mariadb64_vfs; then
        info "MariaDB VFS image (wasm64)"
        return
    fi
    build_mariadb64
    build_dash
    step "Building MariaDB VFS image (wasm64)"
    WASM_POSIX_DEP_TARGET_ARCH=wasm64 \
        bash "$REPO_ROOT/packages/registry/mariadb-vfs/build-mariadb-vfs.sh"
    info "MariaDB VFS image (wasm64) built"
}

build_mariadb_test_vfs() {
    # Declared package (packages/sets/local-supported.toml `[[packages]]`,
    # class = test-support); the engine resolves mariadb/dash/coreutils/dinit
    # and runs packages/registry/mariadb-test/build-mariadb-test.sh (unchanged
    # script). Unlike the six browser-demo composites above, this has no
    # active `[[products]]` entry — matching its sibling test-support
    # manifests test-php.toml/test-sqlite.toml, which are also manifest-only
    # with no declared product — but the bare package is already selectable
    # by `xtask bootstrap mariadb-test`.
    bootstrap_target mariadb-test
}

build_wordpress() {
    # NOTE: the registry package named "wordpress" is the *composed VFS
    # image* (depends_on nginx/php/dinit/msmtpd/shell — see
    # packages/registry/wordpress/package.toml), which is what
    # `build_wp_vfs` below actually builds. This target predates that
    # package and only stages the WordPress source tree setup.sh downloads,
    # so it stays a direct script call rather than `bootstrap_target
    # wordpress` (which would build the whole composed image here).
    if ! has_wordpress; then
        step "Downloading WordPress"
        bash "$REPO_ROOT/packages/registry/wordpress/setup.sh"
        info "WordPress downloaded"
    else
        info "WordPress"
    fi
}

build_wp_vfs() {
    # Declared VFS product (packages/sets/local-supported.toml); the engine's
    # own dependency closure resolves shell/nginx/php/dinit/msmtpd/kernel and
    # the WordPress + SQLite-integration sources, then runs
    # packages/registry/wordpress/build-wordpress.sh (the same script this
    # used to invoke directly).
    bootstrap_target browser-wordpress
}

build_dash() {
    # NOTE: not routed through `bootstrap_target` — the post-build copy
    # below reads packages/registry/dash/bin/dash.wasm, the path
    # build-dash.sh only writes to when run standalone (unset
    # WASM_POSIX_DEP_OUT_DIR/WASM_POSIX_DEP_WORK_DIR); under the engine it
    # writes into a resolver-owned work directory instead, so this copy
    # would silently stop populating host/wasm/sh.wasm if this called
    # `bootstrap_target dash` directly.
    if has_dash; then
        info "dash"
        return
    fi
    need_kernel
    need_sdk
    if ! has_dash; then
        step "Building dash shell"
        bash "$REPO_ROOT/packages/registry/dash/build-dash.sh"
        info "dash built"
    else
        info "dash"
    fi
    # host/wasm/sh.wasm is dash — needed by vitest and run-example.ts
    if [ -f "$REPO_ROOT/packages/registry/dash/bin/dash.wasm" ] && [ ! -f "$REPO_ROOT/host/wasm/sh.wasm" ]; then
        mkdir -p "$REPO_ROOT/host/wasm"
        cp "$REPO_ROOT/packages/registry/dash/bin/dash.wasm" "$REPO_ROOT/host/wasm/sh.wasm"
    fi
}

build_bash() {
    bootstrap_target bash
}

build_coreutils() {
    bootstrap_target coreutils
}

build_grep() {
    bootstrap_target grep
}

build_sed() {
    bootstrap_target sed
}

build_redis() {
    bootstrap_target redis
}

build_dinit() {
    need_kernel
    need_sdk
    # dinit uses libc++ which the mariadb build script installs into
    # the sysroot. Force a mariadb build first if libc++ isn't there
    # — it's the cheapest path to get the headers + library set up.
    if [ ! -f "$REPO_ROOT/sysroot/lib/libc++.a" ]; then
        build_mariadb
    fi
    if ! has_dinit; then
        step "Building dinit"
        bash "$REPO_ROOT/packages/registry/dinit/build-dinit.sh"
        info "dinit built"
    else
        info "dinit"
    fi
}

build_msmtpd() {
    # `xtask bootstrap msmtpd` builds the wasm-fork-instrument CLI first
    # (msmtpd is fork-instrumented); see bootstrap_target_to_selection's
    # Package(name) handling in tools/xtask/src/local_build.rs.
    bootstrap_target msmtpd
}

build_cpython() {
    bootstrap_target cpython
}

build_python_vfs() {
    # NOT folded: "python-vfs" is an `[[exclusions]]` entry in
    # packages/sets/local-supported.toml ("retired standalone browser
    # product") — a pre-existing product decision predating this stage, not
    # an engine limitation (its images/vfs/products/browser-python.toml
    # manifest already exists and validates fine; see
    # run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries in
    # tools/xtask/src/local_build.rs). Reactivating it is out of scope here.
    if has_python_vfs; then
        info "Python VFS image"
        return
    fi
    build_cpython
    step "Building Python VFS image"
    bash "$REPO_ROOT/images/vfs/scripts/build-python-vfs-image.sh"
    info "Python VFS image built"
}

build_perl_vfs() {
    # NOT folded: "perl-vfs" is an `[[exclusions]]` entry in
    # packages/sets/local-supported.toml ("retired standalone browser
    # product") — a pre-existing product decision predating this stage, not
    # an engine limitation (its images/vfs/products/browser-perl.toml
    # manifest already exists and validates fine; see
    # run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries in
    # tools/xtask/src/local_build.rs). Reactivating it is out of scope here.
    if ! has_perl_vfs; then
        if [ ! -f "$REPO_ROOT/packages/registry/perl/perl-src/lib/strict.pm" ]; then
            warn "Perl source not found, skipping perl VFS image"
            return
        fi
        step "Building Perl VFS image"
        bash "$REPO_ROOT/images/vfs/scripts/build-perl-vfs-image.sh"
        info "Perl VFS image built"
    else
        info "Perl VFS image"
    fi
}

build_node() {
    if has_node; then
        info "node"
        return
    fi
    need_kernel
    need_sdk
    local node_wasm="$REPO_ROOT/packages/registry/spidermonkey-node/bin/node.wasm"
    if [ ! -f "$node_wasm" ]; then
        node_wasm="$REPO_ROOT/packages/registry/spidermonkey/bin/node.wasm"
    fi
    if [ ! -f "$node_wasm" ]; then
        build_spidermonkey_node
        node_wasm="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/spidermonkey-node.wasm 2>/dev/null || true)"
    fi
    if [ -f "$node_wasm" ]; then
        step "Installing existing node.wasm into local-binaries"
        source "$REPO_ROOT/scripts/install-local-binary.sh"
        local tmp_dir
        tmp_dir="$(mktemp -d)"
        cp "$node_wasm" "$tmp_dir/node.wasm"
        install_local_binary node "$tmp_dir/node.wasm"
        rm -rf "$tmp_dir"
        info "node installed"
        return
    fi
    step "Building node.wasm"
    local host_target
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_target" --quiet -- build-deps resolve node)
    info "node built"
}

build_spidermonkey_node() {
    if has_spidermonkey_node; then
        info "spidermonkey-node"
        return
    fi
    need_kernel
    need_sdk
    step "Resolving spidermonkey-node.wasm"
    local host_target
    host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    (cd "$REPO_ROOT" && cargo run -p xtask --target "$host_target" --quiet -- \
        build-deps --arch wasm32 --binaries-dir "$REPO_ROOT/binaries" resolve spidermonkey-node)
    info "spidermonkey-node resolved"
}

build_node_vfs() {
    # Declared VFS product; the engine resolves shell/node and runs
    # packages/registry/node-vfs/build-node-vfs.sh (unchanged script).
    bootstrap_target browser-node
}

build_vim_zip() {
    if has_vim_zip; then
        info "vim.zip"
        return
    fi

    step "Packaging vim.zip from cached vim package"
    bash "$REPO_ROOT/images/vfs/scripts/build-vim-zip.sh"
    info "vim.zip built ($(du -h "$REPO_ROOT/apps/browser-demos/public/vim.zip" | cut -f1))"
}

build_nethack_zip() {
    if has_nethack_zip; then
        info "nethack.zip"
        return
    fi

    # nethack.zip = nethack.wasm + runtime tree (nhdat, symbols, license),
    # packaged for the browser shell demo's lazy-archive fetch. NetHack's
    # release archive ships both pieces (build-nethack.sh stages
    # runtime/ alongside nethack.wasm into the resolver scratch), so this
    # builder reads from the cache canonical dir and rezips. Mirrors
    # build_vim_zip.
    step "Packaging nethack.zip from cached nethack package"
    bash "$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh"
    info "nethack.zip built ($(du -h "$REPO_ROOT/apps/browser-demos/public/nethack.zip" | cut -f1))"
}

SOURCE_ROOTFS_SHELL_WORK_ROOT=""
SOURCE_ROOTFS_SHELL_WORK_PREFIX=""
SOURCE_ROOTFS_SHELL_STAGE_BINARIES=""
SOURCE_ROOTFS_SHELL_CANDIDATE=""
SOURCE_ROOTFS_SHELL_OVERRIDE_PATH=""
SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET=""
SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=0
SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=0
SOURCE_ROOTFS_SHELL_FETCHED_MIRROR=""
SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET=""
SOURCE_ROOTFS_SHELL_PUBLIC_TEMP=""
SOURCE_ROOTFS_SHELL_RUNNER_TEMP=""
SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED=0

validate_source_rootfs_shell_pages_mode() {
    SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED=0
    [ "${WASM_POSIX_SOURCE_ROOTFS_SHELL_ISOLATION:-}" = "pages-exact-main-v1" ] || {
        err "--source-rootfs-shell requires the Pages exact-main isolation contract."
        return 2
    }
    [ "${GITHUB_ACTIONS:-}" = "true" ] &&
        [ "${GITHUB_WORKFLOW:-}" = "Deploy GitHub Pages" ] &&
        [ "${GITHUB_JOB:-}" = "deploy" ] || {
        err "--source-rootfs-shell is restricted to the Deploy GitHub Pages/deploy job."
        return 2
    }
    [ "${GITHUB_SERVER_URL:-}" = "https://github.com" ] || {
        err "--source-rootfs-shell requires a supported github.com Pages event."
        return 2
    }
    case "${GITHUB_EVENT_NAME:-}" in
        push|workflow_dispatch) ;;
        *)
            err "--source-rootfs-shell requires a supported github.com Pages event."
            return 2
            ;;
    esac
    [ "${GITHUB_REF:-}" = "refs/heads/main" ] &&
        [ "${GITHUB_REF_NAME:-}" = "main" ] || {
        err "--source-rootfs-shell requires the exact main branch checkout."
        return 2
    }
    [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] &&
        [[ "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ ]] || {
        err "--source-rootfs-shell requires a real GitHub Actions run identity."
        return 2
    }
    [ "${WASM_POSIX_SOURCE_ROOTFS_SHELL_RUNNER_ENVIRONMENT:-}" = "github-hosted" ] &&
        [ "${RUNNER_OS:-}" = "Linux" ] || {
        err "--source-rootfs-shell requires the attested GitHub-hosted Linux Pages runner."
        return 2
    }

    local workspace="${GITHUB_WORKSPACE:-}"
    local workspace_physical
    local repo_physical
    [ -d "$workspace" ] && [ ! -L "$workspace" ] || {
        err "--source-rootfs-shell requires a real GITHUB_WORKSPACE directory."
        return 2
    }
    workspace_physical="$(cd "$workspace" && pwd -P)"
    repo_physical="$(cd "$REPO_ROOT" && pwd -P)"
    [ "$workspace_physical" = "$repo_physical" ] || {
        err "--source-rootfs-shell must run at the GitHub Actions workspace root."
        return 2
    }

    local github_repository="${GITHUB_REPOSITORY:-}"
    local source_repository="${WASM_POSIX_SOURCE_ROOTFS_SHELL_REPOSITORY:-}"
    local source_commit="${WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT:-}"
    [[ "$github_repository" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] &&
        [ "$source_repository" = "https://github.com/$github_repository" ] || {
        err "--source-rootfs-shell repository provenance must match GITHUB_REPOSITORY."
        return 2
    }
    [[ "${GITHUB_SHA:-}" =~ ^[0-9a-f]{40}$ ]] &&
        [ "$source_commit" = "$GITHUB_SHA" ] &&
        [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" = "$GITHUB_SHA" ] || {
        err "--source-rootfs-shell commit provenance must match the checked-out GITHUB_SHA."
        return 2
    }

    [ "$ALREADY_MATERIALIZED" -eq 0 ] &&
        [ "$USE_PR_STAGING" -eq 0 ] || {
        err "--source-rootfs-shell cannot combine with already-materialized or PR-staging modes."
        return 2
    }

    local runner_temp="${RUNNER_TEMP:-}"
    case "$runner_temp" in
        /*) ;;
        *)
            err "--source-rootfs-shell requires an absolute RUNNER_TEMP."
            return 2
            ;;
    esac
    [ "$runner_temp" != "/" ] &&
        [ -d "$runner_temp" ] &&
        [ ! -L "$runner_temp" ] || {
        err "--source-rootfs-shell requires a real, non-root RUNNER_TEMP directory."
        return 2
    }
    local runner_physical
    runner_physical="$(cd "$runner_temp" && pwd -P)"
    [ "$runner_physical" = "$runner_temp" ] || {
        err "--source-rootfs-shell requires a canonical RUNNER_TEMP path."
        return 2
    }

    local cache_root="${WASM_POSIX_BINARY_CACHE_ROOT:-}"
    case "$cache_root" in
        /*) ;;
        *)
            err "--source-rootfs-shell requires an absolute fresh cache path."
            return 2
            ;;
    esac
    [ "$cache_root" = "$runner_temp/$(basename "$cache_root")" ] &&
        [ ! -e "$cache_root" ] &&
        [ ! -L "$cache_root" ] || {
        err "--source-rootfs-shell cache must be a nonexistent direct child of RUNNER_TEMP."
        return 2
    }

    local path
    for path in \
        "$REPO_ROOT/local-binaries" \
        "$REPO_ROOT/binaries" \
        "$REPO_ROOT/local-libs" \
        "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
    do
        if [ -e "$path" ] || [ -L "$path" ]; then
            err "--source-rootfs-shell requires an unmaterialized Pages workspace: $path"
            return 2
        fi
    done
    [ -d "$REPO_ROOT/apps/browser-demos/public" ] &&
        [ ! -L "$REPO_ROOT/apps/browser-demos/public" ] || {
        err "--source-rootfs-shell requires the checked-in browser public directory."
        return 2
    }

    SOURCE_ROOTFS_SHELL_RUNNER_TEMP="$runner_temp"
    SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED=1
}

release_source_rootfs_shell_runtime_override() {
    local failed=0
    clear_source_rootfs_shell_transient_fetched_mirror || failed=1
    if [ -n "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH" ]; then
        if [ -L "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH" ]; then
            if [ "$(readlink "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH")" = "$SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET" ]; then
                if ! rm -- "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH"; then
                    err "Could not remove the source-rootfs shell resolver override"
                    failed=1
                fi
            else
                err "Refusing to remove a changed source-rootfs shell resolver override"
                failed=1
            fi
        elif [ -e "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH" ]; then
            err "Refusing to remove a replaced source-rootfs shell resolver override"
            failed=1
        fi
        if [ "$failed" -eq 0 ] &&
            [ "$SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED" -eq 1 ]; then
            if [ -d "$REPO_ROOT/local-libs/shell" ] &&
                [ ! -L "$REPO_ROOT/local-libs/shell" ]; then
                if ! rmdir "$REPO_ROOT/local-libs/shell" 2>/dev/null; then
                    err "Source-rootfs shell override directory gained unexpected contents"
                    failed=1
                fi
            elif [ -e "$REPO_ROOT/local-libs/shell" ] ||
                [ -L "$REPO_ROOT/local-libs/shell" ]; then
                err "Source-rootfs shell override directory was replaced"
                failed=1
            fi
        fi
        if [ "$failed" -eq 0 ] &&
            [ "$SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED" -eq 1 ]; then
            if [ -d "$REPO_ROOT/local-libs" ] &&
                [ ! -L "$REPO_ROOT/local-libs" ]; then
                if ! rmdir "$REPO_ROOT/local-libs" 2>/dev/null; then
                    err "Source-rootfs local-libs directory gained unexpected contents"
                    failed=1
                fi
            elif [ -e "$REPO_ROOT/local-libs" ] ||
                [ -L "$REPO_ROOT/local-libs" ]; then
                err "Source-rootfs local-libs directory was replaced"
                failed=1
            fi
        fi
    fi
    if [ "$failed" -eq 0 ]; then
        SOURCE_ROOTFS_SHELL_OVERRIDE_PATH=""
        SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET=""
        SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=0
        SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=0
        SOURCE_ROOTFS_SHELL_FETCHED_MIRROR=""
        SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET=""
    fi
    return "$failed"
}

cleanup_source_rootfs_shell_work_root() {
    local failed=0
    release_source_rootfs_shell_runtime_override || failed=1
    if [ -n "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ]; then
        if [ -f "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ] &&
            [ ! -L "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ]; then
            if ! rm -- "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP"; then
                err "Could not remove the source-rootfs public temporary file"
                failed=1
            fi
        elif [ -e "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ] ||
            [ -L "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ]; then
            err "Refusing to remove a replaced source-rootfs public temporary file"
            failed=1
        fi
    fi
    if [ -n "$SOURCE_ROOTFS_SHELL_WORK_ROOT" ]; then
        case "$SOURCE_ROOTFS_SHELL_WORK_PREFIX:$SOURCE_ROOTFS_SHELL_WORK_ROOT" in
            "$SOURCE_ROOTFS_SHELL_RUNNER_TEMP/kandelo-source-rootfs-shell.":"$SOURCE_ROOTFS_SHELL_RUNNER_TEMP/kandelo-source-rootfs-shell."*)
                if ! rm -rf -- "$SOURCE_ROOTFS_SHELL_WORK_ROOT"; then
                    err "Could not remove the source-rootfs shell work root"
                    failed=1
                fi
                ;;
            *)
                err "Refusing to remove unexpected source-rootfs shell work root: $SOURCE_ROOTFS_SHELL_WORK_ROOT"
                failed=1
                ;;
        esac
    fi
    SOURCE_ROOTFS_SHELL_WORK_ROOT=""
    SOURCE_ROOTFS_SHELL_WORK_PREFIX=""
    SOURCE_ROOTFS_SHELL_STAGE_BINARIES=""
    SOURCE_ROOTFS_SHELL_CANDIDATE=""
    SOURCE_ROOTFS_SHELL_PUBLIC_TEMP=""
    SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED=0
    return "$failed"
}

source_rootfs_shell_exit_cleanup() {
    local original_status=$?
    local cleanup_status=0
    trap - EXIT INT TERM
    cleanup_source_rootfs_shell_work_root || cleanup_status=$?
    if [ "$original_status" -ne 0 ]; then
        exit "$original_status"
    fi
    exit "$cleanup_status"
}

initialize_source_rootfs_shell_pages_mode() {
    validate_source_rootfs_shell_pages_mode
    [ "$SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED" -eq 1 ] || {
        err "Internal error: source-rootfs Pages preflight did not complete"
        return 1
    }
    SOURCE_ROOTFS_SHELL_WORK_PREFIX="$SOURCE_ROOTFS_SHELL_RUNNER_TEMP/kandelo-source-rootfs-shell."
    SOURCE_ROOTFS_SHELL_WORK_ROOT="${SOURCE_ROOTFS_SHELL_WORK_PREFIX}${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.${BASHPID:-$$}"
    [ ! -e "$SOURCE_ROOTFS_SHELL_WORK_ROOT" ] &&
        [ ! -L "$SOURCE_ROOTFS_SHELL_WORK_ROOT" ] || {
        err "Source-rootfs shell work directory already exists"
        return 2
    }

    # WHY: a failed or cancelled Pages step cannot advance to build, seal, or
    # deploy. The runner is disposable; cleanup owns only runtime links and
    # transaction-unique temporary paths, never broad package/cache state.
    trap source_rootfs_shell_exit_cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    mkdir "$SOURCE_ROOTFS_SHELL_WORK_ROOT"
    SOURCE_ROOTFS_SHELL_STAGE_BINARIES="$SOURCE_ROOTFS_SHELL_WORK_ROOT/binaries"
    mkdir "$SOURCE_ROOTFS_SHELL_STAGE_BINARIES"
    mkdir "$WASM_POSIX_BINARY_CACHE_ROOT"
}

stage_source_rootfs_shell_vfs() {
    [ "$SOURCE_ROOTFS_SHELL" -eq 1 ] || {
        err "Internal error: source-rootfs shell staging was not explicitly selected"
        return 1
    }
    [ "$SOURCE_ROOTFS_SHELL_PREFLIGHT_VALIDATED" -eq 1 ] || {
        err "Internal error: source-rootfs Pages preflight was bypassed"
        return 1
    }
    if [ -n "$SOURCE_ROOTFS_SHELL_CANDIDATE" ]; then
        [ -f "$SOURCE_ROOTFS_SHELL_CANDIDATE" ] &&
            [ ! -L "$SOURCE_ROOTFS_SHELL_CANDIDATE" ] || {
            err "The staged source-rootfs shell candidate is no longer a regular file"
            return 1
        }
        return 0
    fi

    err "Local source-rootfs shell archive staging was retired; provide a pre-staged candidate via SOURCE_ROOTFS_SHELL_CANDIDATE."
    return 1
}

activate_source_rootfs_shell_resolver_override() {
    local resolved
    resolved="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/shell.vfs.zst)" || {
        err "Could not pin the installed canonical shell generation"
        return 1
    }
    if [ ! -f "$resolved" ] || [ -L "$resolved" ] ||
        ! cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$resolved"; then
        err "The canonical local shell generation is not the verified bridge artifact"
        return 1
    fi

    local local_libs="$REPO_ROOT/local-libs"
    local shell_dir="$local_libs/shell"
    if [ -e "$local_libs" ] || [ -L "$local_libs" ]; then
        err "Source-rootfs Pages mode cannot replace an existing local-libs path"
        return 1
    fi

    local override_path="$shell_dir/build"
    local override_target
    override_target="$(dirname "$resolved")"
    local output_rel
    output_rel="$(pkg_output_rel shell shell.vfs.zst wasm32)" || return 1
    local fetched_mirror="$REPO_ROOT/binaries/programs/wasm32/$output_rel"
    # WHY: the resolver canonicalizes a local-libs scalar target before it
    # creates the fetched-tier mirror. Cleanup must bind the resulting
    # immutable generation path, not the lexical override path.
    local transient_fetched_target="$override_target/shell.vfs.zst"
    if [ -e "$override_path" ] || [ -L "$override_path" ]; then
        err "Source-rootfs mode cannot replace an existing local-libs/shell/build override"
        return 1
    fi
    # Register exact ownership before the first mkdir/link. An EXIT/TERM trap
    # can therefore remove any prefix of this runtime-only activation.
    SOURCE_ROOTFS_SHELL_OVERRIDE_PATH="$override_path"
    SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET="$override_target"
    SOURCE_ROOTFS_SHELL_OVERRIDE_LOCAL_LIBS_CREATED=1
    SOURCE_ROOTFS_SHELL_OVERRIDE_SHELL_DIR_CREATED=1
    SOURCE_ROOTFS_SHELL_FETCHED_MIRROR="$fetched_mirror"
    SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET="$transient_fetched_target"
    mkdir "$local_libs"
    mkdir "$shell_dir"
    # WHY: transitive browser image recipes declare `shell@0.1.0`. Route those
    # normal resolver reads through its supported local-libs override so a
    # full-registry fetch cannot execute the canonical bottle recipe while the
    # explicit bridge mode is active.
    ln -s "$override_target" "$override_path"
}

install_source_rootfs_shell_vfs() {
    initialize_source_rootfs_shell_pages_mode
    stage_source_rootfs_shell_vfs
    local xtask
    xtask="$(pkg_xtask_bin)" || return 1
    local work_suffix="${SOURCE_ROOTFS_SHELL_WORK_ROOT##*.}"
    local install_session="source-rootfs-shell-${WASM_POSIX_SOURCE_ROOTFS_SHELL_COMMIT:0:12}-${work_suffix}-${BASHPID:-$$}"
    local browser_copy="$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"

    # WHY: browser imports intentionally keep the public canonical shell path.
    # Publish only the already-inspected bridge bytes through the package
    # installer; direct copies would bypass the resolver's ownership rules.
    WASM_POSIX_LOCAL_INSTALL_SOURCE="$SOURCE_ROOTFS_SHELL_CANDIDATE" \
    WASM_POSIX_LOCAL_INSTALL_SESSION="$install_session" \
        "$xtask" build-deps --arch wasm32 \
            --binaries-dir "$REPO_ROOT/local-binaries" \
            install-local-artifact shell shell.vfs.zst
    activate_source_rootfs_shell_resolver_override
    if [ -e "$browser_copy" ] || [ -L "$browser_copy" ]; then
        err "Refusing to replace the public source-rootfs shell path"
        return 1
    fi
    local public_dir
    public_dir="$(dirname "$browser_copy")"
    SOURCE_ROOTFS_SHELL_PUBLIC_TEMP="$public_dir/.shell.vfs.zst.source-rootfs-${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}.${BASHPID:-$$}"
    if [ -e "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ] ||
        [ -L "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ]; then
        err "Source-rootfs public temporary path already exists"
        return 1
    fi
    (set -o noclobber; : >"$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP") || {
        err "Could not claim the source-rootfs public temporary path"
        return 1
    }
    # WHY: Vite's resolver import emits a hashed module asset, while the sealed
    # Pages product deliberately boots `/shell.vfs.zst`. Verify the complete
    # temporary copy, then publish it with one same-directory atomic rename.
    cp -- "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP"
    if [ ! -f "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ] ||
        [ -L "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" ] ||
        ! cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP"; then
        err "Source-rootfs public temporary copy did not preserve candidate bytes"
        return 1
    fi
    if [ -e "$browser_copy" ] || [ -L "$browser_copy" ]; then
        err "Public source-rootfs shell path appeared before publication"
        return 1
    fi
    mv -- "$SOURCE_ROOTFS_SHELL_PUBLIC_TEMP" "$browser_copy"
    SOURCE_ROOTFS_SHELL_PUBLIC_TEMP=""
    verify_source_rootfs_shell_runtime_vfs
    info "Source-rootfs Shell VFS bridge installed"
}

clear_source_rootfs_shell_transient_fetched_mirror() {
    [ -n "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ] || return 0
    if [ -L "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ] &&
        [ "$(readlink "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR")" = "$SOURCE_ROOTFS_SHELL_TRANSIENT_FETCHED_TARGET" ]; then
        # The fetched program-cache tier must never retain a local-generation
        # identity. Own and remove only the exact lexical link emitted while
        # the source-mode local-libs override is active.
        if ! rm -- "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR"; then
            err "Could not remove the source-rootfs fetched-tier link"
            return 1
        fi
    elif [ -e "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ] ||
        [ -L "$SOURCE_ROOTFS_SHELL_FETCHED_MIRROR" ]; then
        err "Refusing to clear a changed source-rootfs fetched-tier path"
        return 1
    fi
}

verify_source_rootfs_shell_vfs() {
    [ -n "$SOURCE_ROOTFS_SHELL_CANDIDATE" ] &&
        [ -f "$SOURCE_ROOTFS_SHELL_CANDIDATE" ] &&
        [ ! -L "$SOURCE_ROOTFS_SHELL_CANDIDATE" ] || {
        err "The explicit source-rootfs shell candidate is unavailable"
        return 1
    }
    local resolved
    resolved="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/shell.vfs.zst)" || {
        err "The installed source-rootfs shell is not resolvable at the canonical browser path"
        return 1
    }
    if [ ! -f "$resolved" ] ||
        ! cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$resolved"; then
        err "The canonical browser shell path no longer contains the verified source-rootfs bytes"
        return 1
    fi
    local browser_copy="$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
    if [ ! -f "$browser_copy" ] || [ -L "$browser_copy" ] ||
        ! cmp "$SOURCE_ROOTFS_SHELL_CANDIDATE" "$browser_copy"; then
        err "The stable public shell path no longer contains the verified source-rootfs bytes"
        return 1
    fi
}

verify_source_rootfs_shell_runtime_vfs() {
    verify_source_rootfs_shell_vfs
    if [ ! -L "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH" ] ||
        [ "$(readlink "$SOURCE_ROOTFS_SHELL_OVERRIDE_PATH")" != "$SOURCE_ROOTFS_SHELL_OVERRIDE_TARGET" ]; then
        err "The source-rootfs shell resolver override changed during browser preparation"
        return 1
    fi
}

verify_source_rootfs_shell_browser_closure() {
    verify_source_rootfs_shell_vfs
}

verify_source_rootfs_shell_runtime_browser_closure() {
    verify_source_rootfs_shell_browser_closure
    verify_source_rootfs_shell_runtime_vfs
}

build_shell_vfs() {
    if [ "$SOURCE_ROOTFS_SHELL" -eq 1 ]; then
        # WHY: this branch must return before the canonical `bootstrap_target`
        # fallback below. The explicit bridge was staged, provenance-checked,
        # and installed by prepare-browser before any browser target ran.
        verify_source_rootfs_shell_runtime_browser_closure
        info "Source-rootfs Shell VFS image"
        return
    fi

    # Declared VFS product (packages/sets/local-supported.toml); the engine
    # resolves the "shell" package closure and validates it against
    # images/vfs/products/browser-main-shell.toml.
    bootstrap_target browser-main-shell
}

build_erlang() {
    # NOTE: not routed through `bootstrap_target` — the bin/beam.wasm copy
    # below reads a path build-erlang.sh only writes to when run standalone
    # (unset WASM_POSIX_DEP_OUT_DIR); under the engine, output goes to a
    # resolver-owned directory instead, so this copy would silently stop
    # populating bin/beam.wasm if this called `bootstrap_target erlang`
    # directly (see build_dash's identical note above).
    if has_erlang; then
        info "erlang"
        return
    fi
    need_kernel
    need_sdk
    if ! has_erlang; then
        step "Building Erlang/OTP 28 BEAM"
        bash "$REPO_ROOT/packages/registry/erlang/build-erlang.sh"
        # Build script puts beam.wasm at erlang/ root; browser+serve expect bin/
        local erlang_dir="$REPO_ROOT/packages/registry/erlang"
        if [ -f "$erlang_dir/beam.wasm" ] && [ ! -f "$erlang_dir/bin/beam.wasm" ]; then
            mkdir -p "$erlang_dir/bin"
            cp "$erlang_dir/beam.wasm" "$erlang_dir/bin/beam.wasm"
        fi
        info "Erlang built"
    else
        info "Erlang"
    fi
}

build_erlang_vfs() {
    # NOT folded: "erlang-vfs" is an `[[exclusions]]` entry in
    # packages/sets/local-supported.toml ("deferred product"), and its
    # underlying "erlang" source package is separately excluded ("deferred
    # software") — pre-existing product decisions predating this stage, not
    # an engine limitation (its images/vfs/products/browser-erlang.toml
    # manifest already exists and validates fine; see
    # run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries in
    # tools/xtask/src/local_build.rs). Reactivating it is out of scope here.
    if has_erlang_vfs; then
        info "Erlang VFS image"
        return
    fi
    build_erlang
    step "Building Erlang VFS image"
    bash "$REPO_ROOT/images/vfs/scripts/build-erlang-vfs-image.sh"
    info "Erlang VFS image built"
}

build_lamp_vfs() {
    # Declared VFS product; see build_wp_vfs above. The engine resolves
    # shell/mariadb/nginx/php/dinit/msmtpd/kernel and runs
    # packages/registry/lamp/build-lamp.sh (unchanged script).
    bootstrap_target browser-lamp
}

build_nginx_vfs() {
    # Declared VFS product; the engine resolves shell/nginx/dinit and runs
    # images/vfs/scripts/build-nginx-vfs-image.sh (unchanged script), which
    # is also the nginx-vfs package's own [build] script_path.
    bootstrap_target browser-nginx
}

build_redis_vfs() {
    # NOT folded: "redis-vfs" is an `[[exclusions]]` entry in
    # packages/sets/local-supported.toml ("dormant browser product") — a
    # pre-existing product decision predating this stage, not an engine
    # limitation (its images/vfs/products/browser-redis.toml manifest
    # already exists and validates fine; see
    # run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries in
    # tools/xtask/src/local_build.rs). Reactivating it is out of scope here.
    build_dinit
    build_redis
    if ! has_redis_vfs; then
        step "Building Redis VFS image"
        bash "$REPO_ROOT/images/vfs/scripts/build-redis-vfs-image.sh"
        info "Redis VFS image built"
    else
        info "Redis VFS image"
    fi
}

build_nginx_php_vfs() {
    # Declared VFS product; the engine resolves shell/nginx/php/dinit and
    # runs images/vfs/scripts/build-nginx-php-vfs-image.sh (unchanged
    # script), which is also the nginx-php-vfs package's own build script.
    bootstrap_target browser-nginx-php
}

build_texlive() {
    # NOTE: not routed through `bootstrap_target` — `texlive` is an
    # [[exclusions]] entry in local-supported.toml, so `xtask bootstrap
    # texlive` errors "unknown product or package". Like build_erlang/
    # build_dash, this excluded package keeps its standalone bash recipe.
    if has_texlive; then
        info "texlive"
        return
    fi
    need_kernel
    need_sdk
    if ! has_texlive; then
        step "Building pdftex (TeX Live)"
        bash "$REPO_ROOT/packages/registry/texlive/build-texlive.sh"
        info "pdftex built"
    else
        info "pdftex (TeX Live)"
    fi
}

build_texlive_vfs() {
    # NOT folded: "texlive" (its source package) is an `[[exclusions]]`
    # entry in packages/sets/local-supported.toml ("deferred software"), and
    # unlike the other dormant composites there is no
    # images/vfs/products/*.toml manifest for texlive at all — so, unlike
    # the six products folded above, there is nothing here for a
    # `[[products]]` entry to even declare yet. This builder also has a
    # host-tool-availability skip (below) that a static manifest dependency
    # closure cannot express. See
    # run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries in
    # tools/xtask/src/local_build.rs.
    if has_texlive_vfs; then
        info "TeX Live bundle"
        return
    fi
    # The bundle isn't a release artifact — it's a JSON dump of the
    # texlive runtime tree, only built locally. Without a host pdftex
    # (built by `bash packages/registry/texlive/build-texlive.sh`), the
    # bundle script fails. Skip with a clear hint instead of breaking
    # the browser bring-up — the texlive demo will surface the missing
    # bundle to the user.
    local host_pdftex="$REPO_ROOT/packages/registry/texlive/texlive-build/host/bin/pdftex"
    if [ ! -x "$host_pdftex" ]; then
        warn "Skipping TeX Live bundle (host pdftex not built — run: bash packages/registry/texlive/build-texlive.sh)"
        return
    fi
    build_texlive
    step "Building TeX Live browser bundle"
    bash "$REPO_ROOT/images/vfs/scripts/build-texlive-bundle.sh"
    info "TeX Live bundle built"
}

build_bc() {
    bootstrap_target bc
}

build_file() {
    bootstrap_target file
}

build_less() {
    bootstrap_target less
}

build_lsof() {
    bootstrap_target lsof
}

build_m4() {
    bootstrap_target m4
}

build_make() {
    bootstrap_target make
}

build_tar() {
    bootstrap_target tar
}

build_curl_cli() {
    # NOTE: unlike most targets above, this one is NOT routed through
    # `bootstrap_target` (Stage 3 of the unified-build-front-door plan). The
    # engine's own "curl" package already declares zlib/openssl as real
    # dependency edges and resolves them through the package resolver, but
    # this legacy recipe instead links against sysroot copies installed by
    # build_zlib/build_openssl below — a different, ambient-install
    # mechanism the engine's resolver-materialized dependencies don't
    # populate. Migrating this one requires confirming the modern "curl"
    # package node fully replaces it, which is out of scope here; left as
    # the pre-Stage-3 bash recipe.
    if has_curl; then
        info "curl"
        return
    fi
    need_kernel
    need_sdk
    # The direct legacy curl recipe links against sysroot copies of its
    # declared zlib and OpenSSL dependencies.
    build_zlib
    build_openssl
    # libcurl's build script produces both libcurl.a and the curl CLI.
    step "Building curl (CLI)"
    bash "$REPO_ROOT/packages/registry/libcurl/build-libcurl.sh"
    info "curl built"
}

build_wget() {
    bootstrap_target wget
}

build_gzip() {
    bootstrap_target gzip
}

build_bzip2() {
    bootstrap_target bzip2
}

build_xz() {
    bootstrap_target xz
}

build_zstd() {
    bootstrap_target zstd
}

build_zip() {
    bootstrap_target zip
}

build_unzip() {
    bootstrap_target unzip
}

build_nano() {
    bootstrap_target nano
}

# zlib/openssl/libcurl below install into the ambient `sysroot/` tree for
# build_curl_cli's legacy recipe (see the NOTE there). Not routed through
# `bootstrap_target`: the engine builds these as proper resolver-materialized
# dependency packages under `local-binaries/source-only-v1/`, not into
# `sysroot/`, so switching these three to `bootstrap_target` would silently
# stop populating the ambient copy build_curl_cli still reads.
build_zlib() {
    if has_zlib; then
        info "zlib"
        return
    fi
    need_kernel
    need_sdk
    if ! has_zlib; then
        step "Building zlib"
        bash "$REPO_ROOT/packages/registry/zlib/build-zlib.sh"
        # Install into sysroot
        local ZLIB_DIR="$REPO_ROOT/packages/registry/zlib/zlib-install"
        local SYSROOT="$REPO_ROOT/sysroot"
        cp "$ZLIB_DIR/include/zlib.h" "$ZLIB_DIR/include/zconf.h" "$SYSROOT/include/"
        cp "$ZLIB_DIR/lib/libz.a" "$SYSROOT/lib/"
        mkdir -p "$SYSROOT/lib/pkgconfig"
        sed "s|^prefix=.*|prefix=$SYSROOT|" "$ZLIB_DIR/lib/pkgconfig/zlib.pc" \
            > "$SYSROOT/lib/pkgconfig/zlib.pc"
        info "zlib built"
    else
        info "zlib"
    fi
}

build_openssl() {
    if has_openssl; then
        info "openssl"
        return
    fi
    need_kernel
    need_sdk
    if ! has_openssl; then
        step "Building OpenSSL"
        bash "$REPO_ROOT/packages/registry/openssl/build-openssl.sh"
        # Install into sysroot
        local OPENSSL_DIR="$REPO_ROOT/packages/registry/openssl/openssl-install"
        local SYSROOT="$REPO_ROOT/sysroot"
        # OpenSSL installs to lib/ or lib64/ depending on platform
        local LIBDIR="$OPENSSL_DIR/lib"
        [ -f "$LIBDIR/libssl.a" ] || LIBDIR="$OPENSSL_DIR/lib64"
        cp "$LIBDIR/libssl.a" "$LIBDIR/libcrypto.a" "$SYSROOT/lib/"
        cp -r "$OPENSSL_DIR/include/openssl" "$SYSROOT/include/"
        mkdir -p "$SYSROOT/lib/pkgconfig"
        for pc in libssl.pc libcrypto.pc openssl.pc; do
            if [ -f "$LIBDIR/pkgconfig/$pc" ]; then
                sed "s|^prefix=.*|prefix=$SYSROOT|" "$LIBDIR/pkgconfig/$pc" \
                    > "$SYSROOT/lib/pkgconfig/$pc"
            fi
        done
        info "OpenSSL built"
    else
        info "OpenSSL"
    fi
}

build_libcurl() {
    if has_libcurl; then
        info "libcurl"
        return
    fi
    # libcurl's build script resolves zlib + openssl through the dep cache.
    need_kernel
    need_sdk
    if ! has_libcurl; then
        step "Building libcurl"
        # Force reconfigure if curl was previously built without SSL
        local CURL_SRC="$REPO_ROOT/packages/registry/libcurl/curl-src"
        if [ -f "$CURL_SRC/Makefile" ]; then
            rm -f "$CURL_SRC/Makefile"
        fi
        bash "$REPO_ROOT/packages/registry/libcurl/build-libcurl.sh"
        # Install libcurl + headers into sysroot
        local SYSROOT="$REPO_ROOT/sysroot"
        cp "$CURL_SRC/lib/.libs/libcurl.a" "$SYSROOT/lib/"
        mkdir -p "$SYSROOT/include/curl"
        cp "$CURL_SRC/include/curl"/*.h "$SYSROOT/include/curl/"
        mkdir -p "$SYSROOT/lib/pkgconfig"
        if [ -f "$CURL_SRC/libcurl.pc" ]; then
            sed "s|^prefix=.*|prefix=$SYSROOT|" "$CURL_SRC/libcurl.pc" \
                > "$SYSROOT/lib/pkgconfig/libcurl.pc"
        fi
        info "libcurl built"
    else
        info "libcurl"
    fi
}

build_ncurses() {
    bootstrap_target ncurses
}

build_nethack() {
    bootstrap_target nethack
}

build_fbdoom() {
    bootstrap_target fbdoom
}

build_vim() {
    bootstrap_target vim
}

build_git() {
    # NOTE: not routed through `bootstrap_target` — the stub fallback below
    # writes a placeholder git-remote-http.wasm at an ambient path a real
    # build script controls; leaving this on the pre-Stage-3 bash path
    # avoids changing that fallback's behavior without being able to verify
    # it here.
    if has_git; then
        info "git"
        return
    fi
    # git's build script resolves zlib/openssl/curl through the dep
    # cache itself; no sysroot prep here.
    need_kernel
    need_sdk
    step "Building git"
    bash "$REPO_ROOT/packages/registry/git/build-git.sh"
    info "git built"
    # Stub git-remote-http.wasm for browser demo if build somehow
    # didn't produce one (e.g. user skipped curl resolution manually).
    if [ ! -f "$REPO_ROOT/packages/registry/git/bin/git-remote-http.wasm" ]; then
        mkdir -p "$REPO_ROOT/packages/registry/git/bin"
        printf '\x00asm\x01\x00\x00\x00' > "$REPO_ROOT/packages/registry/git/bin/git-remote-http.wasm"
    fi
}

build_perl() {
    bootstrap_target perl
}

build_ruby() {
    bootstrap_target ruby
}

build_dlopen() {
    if has_dlopen; then
        info "dlopen"
        return
    fi
    need_sysroot
    if ! has_dlopen; then
        step "Building dlopen example"
        bash "$REPO_ROOT/examples/dlopen/build.sh"
        info "dlopen built"
    else
        info "dlopen"
    fi
}

build_target() {
    local target="$1"
    case "$target" in
        kernel)     build_kernel ;;
        sysroot)    build_sysroot ;;
        sysroot64)  build_sysroot64 ;;
        sdk)        build_sdk ;;
        host)       build_host ;;
        rootfs)     build_rootfs ;;
        programs)   build_programs ;;
        nginx)      build_nginx ;;
        php)        build_php ;;
        php-fpm)    build_php_fpm ;;
        dash)       build_dash ;;
        bash)       build_bash ;;
        coreutils)  build_coreutils ;;
        grep)       build_grep ;;
        sed)        build_sed ;;
        mariadb)    build_mariadb ;;
        mariadb64)  build_mariadb64 ;;
        mariadb-vfs) build_mariadb_vfs ;;
        mariadb64-vfs) build_mariadb64_vfs ;;
        mariadb-test) build_mariadb_test_vfs ;;
        redis)      build_redis ;;
        dinit)      build_dinit ;;
        msmtpd)     build_msmtpd ;;
        cpython)    build_cpython ;;
        python-vfs) build_python_vfs ;;
        perl-vfs)   build_perl_vfs ;;
        shell-vfs)  build_shell_vfs ;;
        node)       build_node ;;
        spidermonkey-node) build_spidermonkey_node ;;
        node-vfs)   build_node_vfs ;;
        wordpress)  build_wordpress ;;
        wp-vfs)     build_wp_vfs ;;
        erlang)     build_erlang ;;
        erlang-vfs) build_erlang_vfs ;;
        lamp-vfs)   build_lamp_vfs ;;
        nginx-vfs)  build_nginx_vfs ;;
        redis-vfs)  build_redis_vfs ;;
        nginx-php-vfs) build_nginx_php_vfs ;;
        bc)         build_bc ;;
        file)       build_file ;;
        less)       build_less ;;
        lsof)       build_lsof ;;
        m4)         build_m4 ;;
        make)       build_make ;;
        tar)        build_tar ;;
        curl-cli)   build_curl_cli ;;
        wget)       build_wget ;;
        gzip)       build_gzip ;;
        bzip2)      build_bzip2 ;;
        xz)         build_xz ;;
        zstd)       build_zstd ;;
        zip)        build_zip ;;
        unzip)      build_unzip ;;
        nano)       build_nano ;;
        nethack)    build_nethack ;;
        nethack-zip) build_nethack_zip ;;
        fbdoom)     build_fbdoom ;;
        ncurses)    build_ncurses ;;
        zlib)       build_zlib ;;
        openssl)    build_openssl ;;
        libcurl)    build_libcurl ;;
        vim)        build_vim ;;
        vim-zip)    build_vim_zip ;;
        git)        build_git ;;
        perl)       build_perl ;;
        ruby)       build_ruby ;;
        dlopen)     build_dlopen ;;
        texlive)    build_texlive ;;
        texlive-vfs) build_texlive_vfs ;;
        browser)    build_browser ;;
        all)        build_all ;;
        *)          err "Unknown build target: $target"; cmd_list; exit 1 ;;
    esac
}

# All targets needed for the Kandelo browser UI and retained browser labs.
# Each entry's `has_X` short-circuits when its release binary is in
# `binaries/`, so this loop is a no-op on a fully-built checkout.
# sysroot/sysroot64 are NOT listed: they're toolchain prerequisites for source
# builds, and any `build_X` whose prebuilt is missing calls `need_sysroot`
# lazily.
BROWSER_DEPS=(kernel rootfs programs dash bash coreutils grep sed bc file less m4 make tar curl-cli wget gzip bzip2 xz zstd zip unzip nano lsof vim vim-zip nethack nethack-zip fbdoom git dinit msmtpd nginx nginx-vfs php php-fpm nginx-php-vfs mariadb mariadb-vfs mariadb-test mariadb64 mariadb64-vfs shell-vfs spidermonkey-node node node-vfs wp-vfs lamp-vfs)

build_browser() {
    for t in "${BROWSER_DEPS[@]}"; do
        build_target "$t"
    done
}

build_all() {
    build_kernel
    build_sysroot
    build_sdk
    build_host
    build_rootfs
    build_programs
    build_dash
    build_bash
    build_coreutils
    build_grep
    build_sed
    build_bc
    build_file
    build_less
    build_m4
    build_make
    build_tar
    build_curl_cli
    build_wget
    build_gzip
    build_bzip2
    build_xz
    build_zstd
    build_zip
    build_unzip
    build_nano
    build_vim
    build_nethack
    build_git
    build_nginx
    build_nginx_vfs
    build_php
    build_php_fpm
    build_nginx_php_vfs
    build_mariadb
    build_mariadb_vfs
    build_redis
    build_redis_vfs
    build_dinit
    build_msmtpd
    build_cpython
    build_python_vfs
    build_perl
    build_perl_vfs
    build_ruby
    build_shell_vfs
    build_node_vfs
    build_wordpress
    build_wp_vfs
    build_lamp_vfs
    build_erlang
    build_erlang_vfs
    build_texlive
    build_texlive_vfs
    build_dlopen
}

# ─── Clean targets ────────────────────────────────────────────────────────────

# xtask_clean_target <name> — invalidate one package's or product's compiled
# cache, resolver mirror, and (for products) published browser asset via the
# local-build engine's own dependency graph, inside the dev shell (mirrors
# `bootstrap_target`'s calling convention). `<name>` is the *graph* name
# (a `packages/sets/local-supported.toml` package or product id), which is
# not always the `./run.sh clean` target name that calls it — callers below
# translate the historical target name first, the same way `build_shell_vfs`
# already translates `shell-vfs` to `browser-main-shell` for `bootstrap_target`.
#
# This is what makes `./run.sh rebuild <target>` (clean, then build) actually
# rebuild instead of reporting a cache hit: the old hand-written clean only
# removed a package's legacy standalone-invocation scratch directories
# (`<pkg>-src`, `bin`, ...), which the engine never reads. The compiled cache
# under `~/.cache/kandelo/source-only` is what `bootstrap`'s cache check
# actually consults, and only `xtask clean` knows how to invalidate it — and,
# via `clean_removal_set`, which *other* packages/products also embed this
# one and must be invalidated too (replacing the old hand-kept "also
# invalidated shell.vfs.zst" warnings).
xtask_clean_target() {
    local name="$1"
    local xtask
    xtask="$(pkg_xtask_bin)" || {
        err "xtask_clean_target $name: could not build xtask"
        return 1
    }
    bash "$REPO_ROOT/scripts/dev-shell.sh" "$xtask" clean "$name"
}

clean_target() {
    local target="$1"
    case "$target" in
        kernel)
            # "kernel" is itself a local-build engine package (its build is a
            # pure `cargo build`, routed through `bootstrap_target kernel`);
            # xtask_clean_target invalidates its compiled cache/mirror. The
            # cargo `target/` directories below are the underlying build's
            # own scratch space, which the engine's cache does not track.
            xtask_clean_target kernel
            rm -rf "$REPO_ROOT/target/wasm64-unknown-unknown/" "$REPO_ROOT/target/wasm32-unknown-unknown/"
            warn "Cleaned kernel" ;;
        sysroot)
            rm -rf "$REPO_ROOT/sysroot"
            warn "Cleaned sysroot" ;;
        sysroot64)
            rm -rf "$REPO_ROOT/sysroot64"
            warn "Cleaned sysroot64" ;;
        sdk)
            warn "SDK is worktree-local (sdk/bin wrappers + activate.sh)."
            warn "Nothing to clean. If you previously ran 'npm link', remove it with: (cd sdk && npm unlink)"
            ;;
        host)
            rm -rf "$REPO_ROOT/host/dist"
            warn "Cleaned host" ;;
        rootfs)
            rm -f "$REPO_ROOT/host/wasm/rootfs.vfs"
            warn "Cleaned rootfs.vfs" ;;
        programs)
            rm -f "$REPO_ROOT/host/wasm/fork-exec.wasm"
            rm -f "$REPO_ROOT/host/wasm/"*.wasm 2>/dev/null || true
            warn "Cleaned programs" ;;
        dash)
            xtask_clean_target dash
            rm -rf "$REPO_ROOT/packages/registry/dash/dash-src" \
                   "$REPO_ROOT/packages/registry/dash/bin"
            warn "Cleaned dash" ;;
        bash)
            xtask_clean_target bash
            rm -rf "$REPO_ROOT/packages/registry/bash/bash-src" \
                   "$REPO_ROOT/packages/registry/bash/bin"
            warn "Cleaned bash" ;;
        coreutils)
            xtask_clean_target coreutils
            rm -rf "$REPO_ROOT/packages/registry/coreutils/coreutils-src" \
                   "$REPO_ROOT/packages/registry/coreutils/bin"
            warn "Cleaned coreutils" ;;
        grep)
            xtask_clean_target grep
            rm -rf "$REPO_ROOT/packages/registry/grep/grep-src" \
                   "$REPO_ROOT/packages/registry/grep/bin"
            warn "Cleaned grep" ;;
        sed)
            xtask_clean_target sed
            rm -rf "$REPO_ROOT/packages/registry/sed/sed-src" \
                   "$REPO_ROOT/packages/registry/sed/bin"
            warn "Cleaned sed" ;;
        nginx)
            xtask_clean_target nginx
            rm -rf "$REPO_ROOT/packages/registry/nginx/nginx-src"
            rm -f "$REPO_ROOT/packages/registry/nginx/nginx.wasm"
            warn "Cleaned nginx" ;;
        php)
            xtask_clean_target php
            rm -rf "$REPO_ROOT/packages/registry/php/php-src" \
                   "$REPO_ROOT/packages/registry/php/php-install"
            warn "Cleaned PHP CLI" ;;
        php-fpm)
            rm -f "$REPO_ROOT/local-binaries/programs/wasm32/php/php-fpm.wasm" \
                  "$REPO_ROOT/packages/registry/php/php-src/sapi/fpm/php-fpm"
            warn "Cleaned PHP-FPM" ;;
        mariadb)
            xtask_clean_target mariadb
            rm -rf "$REPO_ROOT/packages/registry/mariadb/mariadb-src" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-install" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-cross-build" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-glue-objs" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-host-build" \
                   "$REPO_ROOT/packages/registry/mariadb/pcre2-"* \
                   "$REPO_ROOT/packages/registry/mariadb/pcre2-wasm-build"
            ;;
        mariadb64)
            # "mariadb64" names the wasm64 build of the mariadb package (the
            # graph has no node literally named "mariadb64"); xtask clean
            # already knows this "64" suffix convention.
            xtask_clean_target mariadb64
            rm -rf "$REPO_ROOT/packages/registry/mariadb/mariadb-install-64" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-cross-build-64" \
                   "$REPO_ROOT/packages/registry/mariadb/mariadb-glue-objs-64"
            warn "Cleaned MariaDB" ;;
        mariadb-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/mariadb.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/mariadb-vfs.vfs.zst"
            warn "Cleaned MariaDB VFS image (wasm32)" ;;
        mariadb64-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/mariadb-64.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm64/mariadb-vfs.vfs.zst"
            warn "Cleaned MariaDB VFS image (wasm64)" ;;
        redis)
            xtask_clean_target redis
            rm -rf "$REPO_ROOT/packages/registry/redis/redis-src" \
                   "$REPO_ROOT/packages/registry/redis/bin"
            warn "Cleaned Redis" ;;
        dinit)
            xtask_clean_target dinit
            rm -rf "$REPO_ROOT/packages/registry/dinit/dinit-src" \
                   "$REPO_ROOT/packages/registry/dinit/bin"
            warn "Cleaned dinit" ;;
        msmtpd)
            xtask_clean_target msmtpd
            rm -rf "$REPO_ROOT/packages/registry/msmtpd/msmtp-src" \
                   "$REPO_ROOT/packages/registry/msmtpd/bin" \
                   "$REPO_ROOT/packages/registry/msmtpd"/msmtp-*.tar.xz
            warn "Cleaned msmtpd" ;;
        cpython)
            xtask_clean_target cpython
            rm -rf "$REPO_ROOT/packages/registry/cpython/cpython-src" \
                   "$REPO_ROOT/packages/registry/cpython/cpython-host-build" \
                   "$REPO_ROOT/packages/registry/cpython/cpython-cross-build" \
                   "$REPO_ROOT/packages/registry/cpython/cpython-install" \
                   "$REPO_ROOT/packages/registry/cpython/bin"
            warn "Cleaned CPython" ;;
        python-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/python.vfs.zst"
            warn "Cleaned Python VFS image" ;;
        perl-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/perl.vfs.zst"
            warn "Cleaned Perl VFS image" ;;
        shell-vfs)
            # "shell-vfs" maps to the browser-main-shell product the same way
            # `build_shell_vfs` maps it to `bootstrap_target browser-main-shell`.
            xtask_clean_target browser-main-shell
            rm -f "$REPO_ROOT/apps/browser-demos/public/shell.vfs.zst"
            pkg_remove_local_output shell shell.vfs.zst wasm32
            warn "Cleaned Shell VFS image" ;;
        node)
            xtask_clean_target node
            rm -rf "$REPO_ROOT/packages/registry/spidermonkey-node/bin" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/node.wasm"
            warn "Cleaned node" ;;
        spidermonkey-node)
            xtask_clean_target spidermonkey-node
            rm -rf "$REPO_ROOT/packages/registry/spidermonkey-node/bin" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/spidermonkey-node.wasm"
            warn "Cleaned spidermonkey-node" ;;
        node-vfs)
            xtask_clean_target node-vfs
            rm -f "$REPO_ROOT/apps/browser-demos/public/node-vfs.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/node-vfs.vfs.zst"
            warn "Cleaned Node VFS image" ;;
        wordpress)
            xtask_clean_target wordpress
            rm -rf "$REPO_ROOT/packages/registry/wordpress/wordpress" \
                   "$REPO_ROOT/packages/registry/wordpress/sqlite-database-integration"
            warn "Cleaned WordPress" ;;
        wp-vfs)
            # "wp-vfs" maps to the browser-wordpress product (package
            # "wordpress"), the same way `build_wp_vfs` maps it to
            # `bootstrap_target browser-wordpress`.
            xtask_clean_target browser-wordpress
            rm -f "$REPO_ROOT/apps/browser-demos/public/wordpress.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/wordpress.vfs.zst"
            warn "Cleaned WP VFS image" ;;
        lamp-vfs)
            # "lamp-vfs" maps to the browser-lamp product, the same way
            # `build_lamp_vfs` maps it to `bootstrap_target browser-lamp`.
            xtask_clean_target browser-lamp
            rm -f "$REPO_ROOT/apps/browser-demos/public/lamp.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/lamp.vfs.zst"
            warn "Cleaned LAMP VFS image" ;;
        nginx-vfs)
            xtask_clean_target nginx-vfs
            rm -f "$REPO_ROOT/apps/browser-demos/public/nginx-vfs.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/nginx-vfs.vfs.zst"
            warn "Cleaned nginx VFS image" ;;
        redis-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/redis.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/redis-vfs.vfs.zst"
            warn "Cleaned Redis VFS image" ;;
        nginx-php-vfs)
            xtask_clean_target nginx-php-vfs
            rm -f "$REPO_ROOT/apps/browser-demos/public/nginx-php-vfs.vfs.zst" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/nginx-php-vfs.vfs.zst"
            warn "Cleaned nginx + PHP-FPM VFS image" ;;
        erlang)
            rm -rf "$REPO_ROOT/packages/registry/erlang/erlang-src" \
                   "$REPO_ROOT/packages/registry/erlang/erlang-install" \
                   "$REPO_ROOT/packages/registry/erlang/bin"
            warn "Cleaned Erlang" ;;
        erlang-vfs)
            rm -f "$REPO_ROOT/apps/browser-demos/public/erlang.vfs.zst"
            warn "Cleaned Erlang VFS image" ;;
        bc)
            xtask_clean_target bc
            rm -rf "$REPO_ROOT/packages/registry/bc/bc-src" \
                   "$REPO_ROOT/packages/registry/bc/bin"
            warn "Cleaned bc" ;;
        file)
            xtask_clean_target file
            rm -rf "$REPO_ROOT/packages/registry/file/file-src" \
                   "$REPO_ROOT/packages/registry/file/bin"
            warn "Cleaned file" ;;
        less)
            xtask_clean_target less
            rm -rf "$REPO_ROOT/packages/registry/less/less-src" \
                   "$REPO_ROOT/packages/registry/less/bin"
            warn "Cleaned less" ;;
        m4)
            xtask_clean_target m4
            rm -rf "$REPO_ROOT/packages/registry/m4/m4-src" \
                   "$REPO_ROOT/packages/registry/m4/bin"
            warn "Cleaned m4" ;;
        make)
            xtask_clean_target make
            rm -rf "$REPO_ROOT/packages/registry/make/make-src" \
                   "$REPO_ROOT/packages/registry/make/bin"
            warn "Cleaned make" ;;
        tar)
            xtask_clean_target tar
            rm -rf "$REPO_ROOT/packages/registry/tar/tar-src" \
                   "$REPO_ROOT/packages/registry/tar/bin"
            warn "Cleaned tar" ;;
        curl-cli)
            # The registry package is named "curl"; "curl-cli" is this
            # script's target name for it.
            xtask_clean_target curl
            rm -rf "$REPO_ROOT/packages/registry/curl/curl-src" \
                   "$REPO_ROOT/packages/registry/curl/bin"
            warn "Cleaned curl" ;;
        wget)
            xtask_clean_target wget
            rm -rf "$REPO_ROOT/packages/registry/wget/wget-src" \
                   "$REPO_ROOT/packages/registry/wget/bin"
            warn "Cleaned wget" ;;
        gzip)
            xtask_clean_target gzip
            rm -rf "$REPO_ROOT/packages/registry/gzip/gzip-src" \
                   "$REPO_ROOT/packages/registry/gzip/bin"
            warn "Cleaned gzip" ;;
        bzip2)
            xtask_clean_target bzip2
            rm -rf "$REPO_ROOT/packages/registry/bzip2/bzip2-src" \
                   "$REPO_ROOT/packages/registry/bzip2/bin"
            warn "Cleaned bzip2" ;;
        xz)
            xtask_clean_target xz
            rm -rf "$REPO_ROOT/packages/registry/xz/xz-src" \
                   "$REPO_ROOT/packages/registry/xz/bin"
            warn "Cleaned xz" ;;
        zstd)
            xtask_clean_target zstd
            rm -rf "$REPO_ROOT/packages/registry/zstd/zstd-src" \
                   "$REPO_ROOT/packages/registry/zstd/bin"
            warn "Cleaned zstd" ;;
        zip)
            xtask_clean_target zip
            rm -rf "$REPO_ROOT/packages/registry/zip/zip-src" \
                   "$REPO_ROOT/packages/registry/zip/bin"
            warn "Cleaned zip" ;;
        unzip)
            xtask_clean_target unzip
            rm -rf "$REPO_ROOT/packages/registry/unzip/unzip-src" \
                   "$REPO_ROOT/packages/registry/unzip/bin"
            warn "Cleaned unzip" ;;
        nano)
            xtask_clean_target nano
            rm -rf "$REPO_ROOT/packages/registry/nano/nano-src" \
                   "$REPO_ROOT/packages/registry/nano/bin"
            warn "Cleaned nano" ;;
        nethack)
            # The cascade to nethack-browser-bundle's nethack.zip and the
            # shell product's shell.vfs.zst is derived from the dependency
            # graph and reported by `xtask clean` itself (nethack <-
            # nethack-browser-bundle <- shell <- browser-main-shell) — not a
            # hand-kept warning here.
            xtask_clean_target nethack
            rm -rf "$REPO_ROOT/packages/registry/nethack/nethack-src" \
                   "$REPO_ROOT/packages/registry/nethack/bin" \
                   "$REPO_ROOT/packages/registry/nethack/runtime"
            rm -f "$REPO_ROOT/apps/browser-demos/public/nethack.zip"
            warn "Cleaned NetHack" ;;
        fbdoom)
            xtask_clean_target fbdoom
            rm -rf "$REPO_ROOT/packages/registry/fbdoom/fbdoom-src" \
                   "$REPO_ROOT/packages/registry/fbdoom/fbdoom-build" \
                   "$REPO_ROOT/local-binaries/programs/wasm32/fbdoom"
            rm -f "$REPO_ROOT/packages/registry/fbdoom/fbdoom.wasm" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/fbdoom.wasm" \
                  "$REPO_ROOT/packages/registry/fbdoom/doom1.wad" \
                  "$REPO_ROOT/packages/registry/fbdoom/COPYING.txt" \
                  "$REPO_ROOT/packages/registry/fbdoom/CREDITS.txt" \
                  "$REPO_ROOT/packages/registry/fbdoom/CREDITS-MUSIC.txt"
            warn "Cleaned fbDOOM" ;;
        ncurses)
            xtask_clean_target ncurses
            rm -rf "$REPO_ROOT/packages/registry/ncurses/ncurses-src"
            # ncurses installs into sysroot, cleaned with sysroot
            warn "Cleaned ncurses (rebuild sysroot to fully clean)" ;;
        zlib)
            xtask_clean_target zlib
            rm -rf "$REPO_ROOT/packages/registry/zlib/zlib-src" \
                   "$REPO_ROOT/packages/registry/zlib/zlib-install"
            # zlib installs into sysroot, cleaned with sysroot
            warn "Cleaned zlib (rebuild sysroot to fully clean)" ;;
        openssl)
            xtask_clean_target openssl
            rm -rf "$REPO_ROOT/packages/registry/openssl/openssl-src" \
                   "$REPO_ROOT/packages/registry/openssl/openssl-install"
            warn "Cleaned OpenSSL (rebuild sysroot to fully clean)" ;;
        libcurl)
            xtask_clean_target libcurl
            rm -rf "$REPO_ROOT/packages/registry/libcurl/curl-src"
            warn "Cleaned libcurl (rebuild sysroot to fully clean)" ;;
        vim)
            # xtask_clean_target invalidates the vim package's own compiled
            # cache/mirror AND (via clean_removal_set's graph cascade) the
            # vim-browser-bundle PACKAGE's and shell PACKAGE's engine cache
            # entries. But vim-browser-bundle is a package node, not a
            # product — clean_package_node_outputs only removes files under
            # local-binaries/source-only-v1/, never apps/browser-demos/
            # public/vim.zip or the legacy local-binaries/programs/wasm32/
            # vim.zip ambient-tier mirror. Those are written by a separate
            # path (build_vim_zip -> images/vfs/scripts/build-vim-zip.sh +
            # install_local_binary), and has_vim_zip() treats either file's
            # mere existence as "already built" — so they must still be
            # removed by hand here, the same way the nethack branch removes
            # nethack.zip.
            xtask_clean_target vim
            rm -rf "$REPO_ROOT/packages/registry/vim/vim-src" \
                   "$REPO_ROOT/packages/registry/vim/bin" \
                   "$REPO_ROOT/packages/registry/vim/runtime"
            rm -f "$REPO_ROOT/apps/browser-demos/public/vim.zip" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/vim.zip"
            warn "Cleaned Vim" ;;
        vim-zip)
            xtask_clean_target vim-browser-bundle
            rm -f "$REPO_ROOT/apps/browser-demos/public/vim.zip" \
                  "$REPO_ROOT/local-binaries/programs/wasm32/vim.zip"
            warn "Cleaned vim.zip" ;;
        git)
            xtask_clean_target git
            rm -rf "$REPO_ROOT/packages/registry/git/git-src" \
                   "$REPO_ROOT/packages/registry/git/bin"
            warn "Cleaned git" ;;
        perl)
            xtask_clean_target perl
            rm -rf "$REPO_ROOT/packages/registry/perl/perl-src" \
                   "$REPO_ROOT/packages/registry/perl/bin"
            warn "Cleaned Perl" ;;
        ruby)
            xtask_clean_target ruby
            rm -rf "$REPO_ROOT/packages/registry/ruby/ruby-src" \
                   "$REPO_ROOT/packages/registry/ruby/ruby-host-build" \
                   "$REPO_ROOT/packages/registry/ruby/ruby-cross-build" \
                   "$REPO_ROOT/packages/registry/ruby/ruby-install" \
                   "$REPO_ROOT/packages/registry/ruby/bin"
            warn "Cleaned Ruby" ;;
        texlive)
            rm -rf "$REPO_ROOT/packages/registry/texlive/texlive-src" \
                   "$REPO_ROOT/packages/registry/texlive/texlive-host-build" \
                   "$REPO_ROOT/packages/registry/texlive/texlive-cross-build" \
                   "$REPO_ROOT/packages/registry/texlive/bin"
            warn "Cleaned TeX Live" ;;
        texlive-vfs)
            rm -rf "$REPO_ROOT/packages/registry/texlive/texlive-dist" \
                   "$REPO_ROOT/packages/registry/texlive/texlive-fmt" \
                   "$REPO_ROOT/packages/registry/texlive/install-tl" \
                   "$REPO_ROOT/packages/registry/texlive/texlive.profile"
            rm -f "$REPO_ROOT/apps/browser-demos/public/texlive-bundle.json"
            warn "Cleaned TeX Live VFS" ;;
        dlopen)
            rm -f "$REPO_ROOT/examples/dlopen/hello-lib.so" \
                  "$REPO_ROOT/examples/dlopen/main.wasm"
            warn "Cleaned dlopen" ;;
        browser)
            for t in "${BROWSER_DEPS[@]}"; do
                clean_target "$t"
            done ;;
        all)
            for t in kernel sysroot sysroot64 host rootfs programs dash bash coreutils grep sed bc file less m4 make tar curl-cli wget gzip bzip2 xz zstd zip unzip nano ncurses zlib openssl libcurl vim vim-zip git nginx php php-fpm mariadb mariadb-vfs mariadb64 mariadb64-vfs redis dinit msmtpd cpython python-vfs perl perl-vfs ruby shell-vfs node node-vfs wordpress wp-vfs lamp-vfs erlang erlang-vfs texlive texlive-vfs dlopen; do
                clean_target "$t"
            done ;;
        *)  err "Unknown clean target: $target"; exit 1 ;;
    esac
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_build() {
    if [ $# -eq 0 ]; then
        build_all
    else
        for t in "$@"; do
            build_target "$t"
        done
    fi
    echo ""
    info "Build complete"
}

cmd_clean() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 clean <target...>"
        err "Use 'clean all' to clean everything"
        exit 1
    fi
    for t in "$@"; do
        clean_target "$t"
    done
    echo ""
    info "Clean complete"
}

cmd_rebuild() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 rebuild <target...>"
        err "Use 'rebuild all' to rebuild everything"
        exit 1
    fi
    # `clean_target` now derives the local-build engine's cache/mirror
    # invalidation from the dependency graph (`xtask clean`), so an ordinary
    # `build_target` after it is a genuine rebuild rather than a cache hit.
    # There used to be a "rebuild target" environment signal threaded through
    # here for `build_target` to read; its one reader (`build_shell_vfs`'s
    # stale-cache guard) was removed when the local-build engine took over
    # cache freshness, so the signal was dead and has been dropped too.
    for t in "$@"; do
        clean_target "$t"
        build_target "$t"
    done
    echo ""
    info "Rebuild complete"
}

cmd_local_build() {
    local emit_json=0
    if [ "${1:-}" = "--json" ]; then
        emit_json=1
        shift
    fi
    if [ $# -ne 0 ]; then
        err "Usage: $0 local-build [--json]"
        err "Use xtask local-build directly for custom product selections."
        exit 2
    fi

    local result_file
    result_file="$(mktemp "${TMPDIR:-/tmp}/kandelo-local-build-result.XXXXXX")"
    LOCAL_BUILD_RESULT_FILE="$result_file"
    trap 'if [ -n "${LOCAL_BUILD_RESULT_FILE:-}" ]; then rm -f -- "$LOCAL_BUILD_RESULT_FILE"; fi' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    local helper="$REPO_ROOT/scripts/run-local-build.sh"
    # A marker inherited from an older or reinitialized shell does not prove
    # that PATH matches this checkout's current flake. Package builds are the
    # reproducibility boundary, so always enter the declared shell again.
    # Write the helper's machine result inside that shell: Nix warnings and
    # shell-hook banners share the launcher's stdout, so capturing the outer
    # stream would corrupt the JSON protocol before jq can validate it.
    local command=(
        bash "$REPO_ROOT/scripts/dev-shell.sh"
        bash -c 'exec bash "$1" >"$2"' kandelo-local-build "$helper" "$result_file"
    )

    local command_status
    if "${command[@]}" >&2; then
        command_status=0
    else
        command_status=$?
    fi

    if [ "$emit_json" -eq 1 ]; then
        local output_status
        if command cat -- "$result_file"; then
            output_status=0
        else
            output_status=$?
        fi
        rm -f -- "$result_file"
        LOCAL_BUILD_RESULT_FILE=""
        trap - EXIT INT TERM
        if [ "$command_status" -ne 0 ]; then
            return "$command_status"
        fi
        return "$output_status"
    fi

    local outcome
    if ! outcome="$(jq -er '
        if .schema == 1 and
           .policy == "source-only-v1" and
           (.outcome == "succeeded" or .outcome == "failed") and
           (.nodes | type == "array")
        then .outcome
        else error("invalid local-build result")
        end
    ' "$result_file" 2>/dev/null)"; then
        err "Local build did not produce a valid final result."
        rm -f -- "$result_file"
        LOCAL_BUILD_RESULT_FILE=""
        trap - EXIT INT TERM
        if [ "$command_status" -eq 0 ]; then
            return 1
        fi
        return "$command_status"
    fi

    jq -r --argjson command_status "$command_status" '
        .nodes as $nodes |
        ($nodes | length) as $total |
        ($nodes | map(select(.state == "succeeded")) | length) as $succeeded |
        ($nodes | map(select(.state == "succeeded" and .disposition == "cached")) | length) as $cached |
        ($nodes | map(select(.state == "succeeded" and .disposition == "published")) | length) as $published |
        ($nodes | map(select(.node.kind == "product")) | length) as $product_total |
        ($nodes | map(select(.node.kind == "product" and .state == "succeeded")) | length) as $product_succeeded |
        ($nodes | map(select(.state == "failed")) | length) as $failed |
        ($nodes | map(select(.state == "blocked")) | length) as $blocked |
        [
            "Local build \(if .outcome == "succeeded" and $command_status == 0 then "succeeded" else "failed" end)",
            "  Nodes:      \($succeeded)/\($total)",
            "  Cache hits: \($cached)",
            "  Built:      \($published)",
            "  Products:   \($product_succeeded)/\($product_total)"
        ] +
        (if $failed > 0 then ["  Failed:     \($failed)"] else [] end) +
        (if $blocked > 0 then ["  Blocked:    \($blocked)"] else [] end) +
        ["  Output:     local-binaries/source-only-v1"] |
        .[]
    ' "$result_file"

    rm -f -- "$result_file"
    LOCAL_BUILD_RESULT_FILE=""
    trap - EXIT INT TERM
    if [ "$command_status" -ne 0 ]; then
        return "$command_status"
    fi
    if [ "$outcome" != "succeeded" ]; then
        return 1
    fi
}

# One-command hermetic setup: fork-instrument host tool, then the
# local-build engine over the whole supported set, then the TypeScript host
# build. Delegates to xtask bootstrap (scripts/setup.sh) inside the
# repository dev shell; see docs/agent-guidance/packages-and-builds.md.
cmd_setup() {
    exec bash "$REPO_ROOT/scripts/dev-shell.sh" \
        bash "$REPO_ROOT/scripts/setup.sh" "$@"
}

cmd_run() {
    if [ $# -eq 0 ]; then
        err "Usage: $0 run <example> [args...]"
        err "Examples: shell, nginx, redis, mariadb, wordpress, wordpress-nginx, lamp, erlang, dlopen"
        exit 1
    fi

    local example="$1"; shift
    need_node_modules

    case "$example" in
        nginx)
            build_nginx_vfs
            step "Starting nginx"
            exec npx tsx "$REPO_ROOT/packages/registry/nginx/demo/serve.ts" "$@"
            ;;
        mariadb)
            local use_wasm64=false
            for arg in "$@"; do
                if [ "$arg" = "--wasm64" ]; then
                    use_wasm64=true
                fi
            done
            if [ "$use_wasm64" = true ]; then
                build_mariadb64_vfs
            else
                build_mariadb_vfs
            fi
            step "Starting MariaDB"
            exec npx tsx "$REPO_ROOT/packages/registry/mariadb/demo/serve.ts" "$@"
            ;;
        redis)
            build_redis_vfs
            step "Starting Redis"
            exec npx tsx "$REPO_ROOT/packages/registry/redis/demo/serve.ts" "$@"
            ;;
        wordpress)
            build_wp_vfs
            step "Starting WordPress (nginx + PHP-FPM + SQLite)"
            exec npx tsx "$REPO_ROOT/packages/registry/wordpress/demo/serve.ts" "$@"
            ;;
        wordpress-nginx)
            build_wp_vfs
            step "Starting WordPress (nginx + PHP-FPM + SQLite)"
            exec npx tsx "$REPO_ROOT/packages/registry/wordpress/demo/serve-nginx.ts" "$@"
            ;;
        lamp)
            build_lamp_vfs
            step "Starting LAMP stack (MariaDB + PHP-FPM + nginx + WordPress)"
            exec npx tsx "$REPO_ROOT/packages/registry/lamp/demo/serve.ts" "$@"
            ;;
        shell)
            build_programs
            build_dash
            build_coreutils
            build_grep
            build_sed
            need_host
            step "Starting interactive shell"
            exec npx tsx "$REPO_ROOT/packages/registry/shell/demo/serve.ts" "$@"
            ;;
        erlang)
            build_erlang
            step "Starting Erlang BEAM"
            exec npx tsx "$REPO_ROOT/packages/registry/erlang/demo/serve.ts" "$@"
            ;;
        dlopen)
            build_dlopen
            step "Running dlopen example"
            exec npx tsx "$REPO_ROOT/examples/dlopen/serve.ts" "$@"
            ;;
        *)
            err "Unknown example: $example"
            err "Available: shell, nginx, redis, mariadb, wordpress, wordpress-nginx, lamp, erlang, dlopen"
            exit 1
            ;;
    esac
}

cmd_prepare_browser() {
    cmd_local_build
    export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
    export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$REPO_ROOT/local-binaries/source-only-v1"
    # The authenticated group is a production-output contract. The Vite dev
    # server reads the same verified projection directly and must not inherit
    # an unrelated production map from the caller's environment.
    unset KANDELO_PAGES_PRODUCT_MAP KANDELO_PAGES_VFS_ASSET_GROUP_DIR
    info "Local SourceOnly browser assets are ready"
}

cmd_browser() {
    local BROWSER_DIR="$REPO_ROOT/apps/browser-demos"

    cmd_prepare_browser

    # Install browser deps if needed (re-run if package.json is newer than node_modules)
    if [ ! -d "$BROWSER_DIR/node_modules" ] || [ "$BROWSER_DIR/package.json" -nt "$BROWSER_DIR/node_modules" ]; then
        warn "Installing browser example dependencies"
        cd "$BROWSER_DIR" && npm install && cd "$REPO_ROOT"
    fi

    step "Starting Vite browser dev server"
    cd "$BROWSER_DIR"
    exec npx vite "$@"
}

cmd_test() {
    local suites=("$@")
    if [ ${#suites[@]} -eq 0 ]; then
        suites=(cargo vitest libc posix)
    fi

    # Pre-test freshness check (not a divergence guard: Stage 2 collapsed
    # Node and browser binary resolution onto one hermetic kernel tier, so
    # there is exactly one kernel copy to go stale). Fails loud here so a
    # kernel built before the last source change cannot silently pass
    # Vitest/conformance against yesterday's ABI. A no-op when no local
    # kernel build exists yet (nothing to verify before `./run.sh setup`).
    step "Verifying local kernel freshness"
    local verify_fresh_host_target
    verify_fresh_host_target="$(rustc -vV | awk '/^host/ {print $2}')"
    if ! (cd "$REPO_ROOT" && cargo run -p xtask --target "$verify_fresh_host_target" --quiet -- verify-fresh); then
        err "Local kernel artifact is stale; rebuild with ./run.sh setup before running tests"
        exit 1
    fi

    local failed=0
    for suite in "${suites[@]}"; do
        case "$suite" in
            cargo)
                step "Running cargo tests"
                if ! cargo test -p kandelo --target aarch64-apple-darwin --lib; then
                    failed=1
                fi
                ;;
            vitest)
                step "Running vitest"
                cd "$REPO_ROOT/host"
                if ! npx vitest run; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            libc)
                step "Running libc-test suite"
                if ! bash "$REPO_ROOT/scripts/run-libc-tests.sh"; then
                    failed=1
                fi
                ;;
            posix)
                step "Running POSIX test suite"
                if ! bash "$REPO_ROOT/scripts/run-posix-tests.sh"; then
                    failed=1
                fi
                ;;
            sortix)
                step "Running Sortix test suite"
                if ! bash "$REPO_ROOT/scripts/run-sortix-tests.sh" --all; then
                    failed=1
                fi
                ;;
            browser)
                step "Running browser E2E tests"
                cd "$REPO_ROOT/apps/browser-demos"
                [ -d node_modules ] || npm install
                if ! npx playwright test --grep-invert "@slow"; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            browser-all)
                step "Running ALL browser E2E tests (including @slow)"
                cd "$REPO_ROOT/apps/browser-demos"
                [ -d node_modules ] || npm install
                if ! npx playwright test; then
                    failed=1
                fi
                cd "$REPO_ROOT"
                ;;
            mariadb)
                info "Running MariaDB mysql-test suite..."
                if ! bash "$REPO_ROOT/scripts/run-mariadb-tests.sh"; then
                    failed=1
                fi
                ;;
            browser-mariadb)
                info "Running MariaDB mysql-test suite (browser)..."
                if ! bash "$REPO_ROOT/scripts/run-browser-mariadb-tests.sh"; then
                    failed=1
                fi
                ;;
            nginx)
                info "Running nginx test suite..."
                if ! bash "$REPO_ROOT/scripts/run-nginx-tests.sh"; then
                    failed=1
                fi
                ;;
            sqlite)
                info "Running SQLite test suite..."
                if ! bash "$REPO_ROOT/scripts/run-sqlite-tests.sh"; then
                    failed=1
                fi
                ;;
            sqlite-upstream)
                step "Running SQLite upstream test suite"
                if ! bash "$REPO_ROOT/scripts/run-sqlite-upstream-tests.sh" --quick; then
                    failed=1
                fi
                ;;
            all)
                cmd_test cargo vitest libc posix sortix browser
                return $?
                ;;
            *)
                err "Unknown test suite: $suite"
                err "Available: cargo, vitest, libc, posix, sortix, sqlite-upstream, browser, browser-all, mariadb, browser-mariadb, nginx, sqlite, all"
                exit 1
                ;;
        esac
    done

    if [ "$failed" -ne 0 ]; then
        err "Some test suites failed"
        exit 1
    fi
    info "All test suites passed"
}

cmd_list() {
    echo "${BOLD}One-command setup:${RESET}"
    echo "  ./run.sh setup                       Hermetic build: fork-instrument tool,"
    echo "                                        local-build engine (all packages),"
    echo "                                        then the TypeScript host"
    echo ""
    echo "${BOLD}Local SourceOnly build:${RESET}"
    echo "  ./run.sh local-build                Build all seven local VFS products"
    echo "                                        and their package dependencies"
    echo "  ./run.sh local-build --json         Emit the canonical machine result"
    echo ""
    echo "${BOLD}Build targets:${RESET}"
    # kernel/sysroot/sysroot64/sdk/host/rootfs status below is inlined
    # rather than going through a has_* helper: xtask's local-build engine
    # (not a bash existence check) is the freshness authority for these
    # now, and this display is only ever a "does something exist on disk
    # yet" hint, not a build gate — see docs/agent-guidance/
    # packages-and-builds.md.
    echo "  kernel      Rust kernel + userspace Wasm         $(has_resolvable kernel.wasm && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sysroot     musl libc sysroot (wasm32)           $([ -f "$REPO_ROOT/sysroot/lib/libc.a" ] && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sysroot64   musl libc sysroot (wasm64)           $([ -f "$REPO_ROOT/sysroot64/lib/libc.a" ] && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sdk         SDK cross-compilation tools           $(command -v wasm32posix-cc &>/dev/null && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  host        TypeScript host (tsup)                $([ -d "$REPO_ROOT/host/dist" ] && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  rootfs      Canonical host rootfs.vfs             $([ -f "$REPO_ROOT/host/wasm/rootfs.vfs" ] && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  programs    Simple C programs (sh, cat, ls, ...)  $(has_programs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dash        dash 0.5.12 shell                      $(has_dash && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  bash        bash 5.2 shell                         $(has_bash && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  coreutils   GNU coreutils 9.6                      $(has_coreutils && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  grep        GNU grep 3.11                          $(has_grep && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  sed         GNU sed 4.9                            $(has_sed && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  bc          bc calculator                          $(has_bc && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  file        file type identifier                   $(has_file && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  less        less pager                             $(has_less && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  m4          GNU m4 macro processor                 $(has_m4 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  make        GNU make                               $(has_make && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  tar         GNU tar                                $(has_tar && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  curl-cli    curl CLI                               $(has_curl && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wget        GNU wget                               $(has_wget && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  gzip        gzip compression                       $(has_gzip && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  bzip2       bzip2 compression                      $(has_bzip2 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  xz          xz/lzma compression                    $(has_xz && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  zstd        Zstandard compression                  $(has_zstd && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  zip         zip archiver                           $(has_zip && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  unzip       unzip extractor                        $(has_unzip && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nano        nano text editor                       $(has_nano && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  ncurses     ncurses library                        $(has_ncurses && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  vim         Vim 9.1 text editor                    $(has_vim && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nethack     NetHack 3.6.7 roguelike (curses)       $(has_nethack && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  fbdoom      fbDOOM (framebuffer DOOM via /dev/fb0) $(has_fbdoom && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  git         Git 2.47.1                             $(has_git && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nginx       nginx 1.24 Wasm binary                $(has_nginx && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nginx-vfs   nginx service VFS image               $(has_nginx_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  php         PHP 8.3 CLI binary                    $(has_php && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  php-fpm     PHP-FPM Wasm binary                   $(has_php_fpm && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  nginx-php-vfs nginx + PHP-FPM VFS image           $(has_nginx_php_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  mariadb     MariaDB 10.5 Wasm binary (wasm32)     $(has_mariadb && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  mariadb64   MariaDB 10.5 Wasm binary (wasm64)     $(has_mariadb64 && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  redis       Redis 7.2 Wasm binary                 $(has_redis && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  redis-vfs   Redis service VFS image               $(has_redis_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dinit       dinit service supervisor              $(has_dinit && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  msmtpd      Local SMTP capture server             $(has_msmtpd && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  cpython     CPython 3.13 Wasm binary              $(has_cpython && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  python-vfs  Python stdlib VFS image               $(has_python_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  perl-vfs    Perl stdlib VFS image                 $(has_perl_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  shell-vfs   Shell environment VFS image           $(has_shell_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  node        SpiderMonkey Node compatibility binary $(has_node && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  spidermonkey-node  SpiderMonkey Node-compatible binary $(has_spidermonkey_node && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  node-vfs    Node + npm VFS image                  $(has_node_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wordpress   WordPress + SQLite plugin             $(has_wordpress && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  wp-vfs      WordPress VFS image                   $(has_wp_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  lamp-vfs    WordPress LAMP VFS image              $(has_lamp_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  perl        Perl 5.40                              $(has_perl && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  ruby        Ruby                                   $(has_ruby && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  erlang      Erlang/OTP 28 BEAM VM                   $(has_erlang && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  erlang-vfs  Erlang OTP VFS image                  $(has_erlang_vfs && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  dlopen      dlopen shared library example          $(has_dlopen && echo "${GREEN}✓${RESET}" || echo "${YELLOW}○${RESET}")"
    echo "  browser     All browser demo dependencies"
    echo "  all         Build everything"
    echo ""
    echo "${BOLD}Clean/rebuild:${RESET}"
    echo "  ./run.sh clean <target...>           Remove build artifacts"
    echo "  ./run.sh clean all                   Remove all build artifacts"
    echo "  ./run.sh rebuild <target...>         Clean + rebuild specific targets"
    echo ""
    echo "${BOLD}Top-level flags:${RESET}"
    echo "  --pr-staging                         Use the current PR's staging binary"
    echo "                                        index for fetch/package commands."
    echo "                                        Browser commands reject this mode."
    echo ""
    echo "${BOLD}Run examples:${RESET}"
    echo "  ./run.sh run shell                   Interactive shell (dash + coreutils + grep + sed)"
    echo "  ./run.sh run nginx [port]            nginx HTTP server"
    echo "  ./run.sh run redis [port]            Redis key-value store"
    echo "  ./run.sh run mariadb                 MariaDB standalone"
    echo "  ./run.sh run wordpress [port]        WordPress (nginx + PHP-FPM + SQLite)"
    echo "  ./run.sh run wordpress-nginx [port]  WordPress (nginx + PHP-FPM + SQLite)"
    echo "  ./run.sh run lamp [port]             Full LAMP stack (MariaDB + nginx + PHP-FPM)"
    echo "  ./run.sh run erlang [-eval 'Expr']    Erlang BEAM VM"
    echo "  ./run.sh run dlopen                  dlopen shared library demo"
    echo ""
    echo "${BOLD}Browser:${RESET}"
    echo "  ./run.sh prepare-browser             Build local SourceOnly browser assets"
    echo "  ./run.sh browser                     Build locally and start the Vite dev server"
    echo ""
    echo "${BOLD}Test suites:${RESET}"
    echo "  ./run.sh test                        Run default suites (cargo + vitest + libc + posix)"
    echo "  ./run.sh test cargo                  Kernel unit tests"
    echo "  ./run.sh test vitest                 Host integration tests"
    echo "  ./run.sh test libc                   musl libc-test conformance"
    echo "  ./run.sh test posix                  Open POSIX test suite"
    echo "  ./run.sh test sortix                 Sortix os-test suite"
    echo "  ./run.sh test browser                Browser E2E tests (fast only)"
    echo "  ./run.sh test browser-all            Browser E2E tests (including slow)"
    echo "  ./run.sh test mariadb                MariaDB mysql-test suite (Node.js)"
    echo "  ./run.sh test browser-mariadb        MariaDB mysql-test suite (browser)"
    echo "  ./run.sh test nginx                  nginx test suite (32 upstream tests)"
    echo "  ./run.sh test sqlite                 SQLite test suite (17 SQL tests)"
    echo "  ./run.sh test all                    All suites including sortix + browser"
}

# ─── Main dispatch ────────────────────────────────────────────────────────────

case "${1:-list}" in
    build)    cmd_build "${@:2}" ;;
    rebuild)  cmd_rebuild "${@:2}" ;;
    clean)    cmd_clean "${@:2}" ;;
    local-build) cmd_local_build "${@:2}" ;;
    setup)    cmd_setup "${@:2}" ;;
    prepare-browser) cmd_prepare_browser ;;
    run)      cmd_run "${@:2}" ;;
    browser)  cmd_browser "${@:2}" ;;
    test)     cmd_test "${@:2}" ;;
    list)     cmd_list ;;
    -h|--help|help) cmd_list ;;
    *)
        err "Unknown command: $1"
        echo ""
        cmd_list
        exit 1
        ;;
esac
