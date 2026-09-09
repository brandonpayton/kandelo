#!/usr/bin/env bash
#
# Canonical entry to the kandelo dev shell.
#
# Always uses `nix develop --ignore-environment` so only flake.nix's
# declared `packages` are visible. Builds fail immediately on a
# missing dep rather than silently leaking a host tool from PATH.
# That latent class of bug is exactly what triggered PR #406
# (force-rebuild's source-build path tripping over undeclared host
# curl, python, perl, etc. that the flake didn't declare).
#
# `--keep` preserves only the specific env vars CI workflows and
# interactive use need. `HOME` is required because cargo/npm/git
# all stash state under `~/`. The `INPUT_*` and `GITHUB_*` lists
# carry workflow-context vars through (dispatch inputs, ref/sha names).
# `GH_TOKEN` is kept for the GitHub CLI, while `GITHUB_TOKEN` is
# intentionally not kept so Nix does not treat a repo-scoped Actions
# token as a general-purpose token for public GitHub flake inputs.
# `CI`, `LOGNAME`, `USER` carry GHA-runner
# identity through to test scripts: `run-sortix-tests.sh` checks
# `${CI:-}` to skip flaky tests, and musl's `getlogin()` reads
# `LOGNAME`/`USER` (the os-test getlogin probe expects either a
# valid login name or NULL+ENOTTY/ENXIO; without LOGNAME it gets
# NULL+errno=0 and FAILs). PATH is intentionally NOT kept — Nix
# rebuilds it from the flake so anything that needs to leak from
# the host raises a "command not found" instead of building wrong.
#
# Usage:
#   scripts/dev-shell.sh bash scripts/build-musl.sh   # one-shot command
#   scripts/dev-shell.sh bash                         # interactive shell
#
# Workflow YAMLs invoke it via `bash scripts/dev-shell.sh ...`. To
# add a new keep, edit this file once — the keep-list is a single
# source of truth instead of being re-declared inline in every
# workflow step.

set -euo pipefail

if [ $# -eq 0 ]; then
    echo "usage: $0 <command> [args...]" >&2
    echo "  e.g.: $0 bash scripts/build-musl.sh" >&2
    echo "        $0 bash                       # interactive pure shell" >&2
    exit 2
fi

# Keep the exact outer Nix executable available to protected tooling that must
# realize a second, exact-head dev environment. Nix itself is intentionally not
# a package in Kandelo's development shell, so resolving it from the inner PATH
# would either fail or leak an ambient substitute.
if [ -n "${KANDELO_NIX_BIN:-}" ]; then
    case "$KANDELO_NIX_BIN" in
        /*) [ -x "$KANDELO_NIX_BIN" ] ;;
        *) false ;;
    esac || {
        echo "dev-shell.sh: KANDELO_NIX_BIN must be an executable absolute path" >&2
        exit 2
    }
else
    KANDELO_NIX_BIN="$(command -v nix)"
    case "$KANDELO_NIX_BIN" in
        /*) [ -x "$KANDELO_NIX_BIN" ] ;;
        *) false ;;
    esac || {
        echo "dev-shell.sh: Nix is unavailable" >&2
        exit 2
    }
fi
export KANDELO_NIX_BIN

dev_command=("$@")
# A top-level non-interactive login Bash reads /etc/profile after Nix's
# shellHook and can replace the declared PATH with Darwin host defaults. Keep
# the wrapper narrow: only repair the common `bash -lc <command>` form used by
# repository workflows. Ordinary child shells and package-specific PATH
# prefixes are untouched.
if [ "${dev_command[0]##*/}" = "bash" ] \
   && [ "${dev_command[1]:-}" = "-lc" ] \
   && [ "${#dev_command[@]}" -ge 3 ]; then
    dev_command[2]=': "${KANDELO_DEV_SHELL_TOOL_PATH:?missing declared dev-shell tool path}"; export PATH="$KANDELO_DEV_SHELL_TOOL_PATH:$PATH"; '"${dev_command[2]}"
fi

nix_develop=(
    "$KANDELO_NIX_BIN" develop
    --ignore-environment \
    --keep HOME \
    --keep TERM \
    --keep CI \
    --keep LOGNAME \
    --keep USER \
    --keep INPUT_PACKAGES \
    --keep INPUT_ARCHES \
    --keep INPUT_REF \
    --keep INPUT_SKIP_TESTS \
    --keep INPUT_BUMP_LOCKFILE \
    --keep ABI_STAGING_GITHUB_API_TOKEN \
    --keep GH_TOKEN \
    --keep GITHUB_REPOSITORY \
    --keep GITHUB_ACTOR \
    --keep GITHUB_REF \
    --keep GITHUB_REF_NAME \
    --keep GITHUB_SHA \
    --keep GITHUB_RUN_ID \
    --keep GITHUB_RUN_ATTEMPT \
    --keep GITHUB_SERVER_URL \
    --keep GITHUB_WORKFLOW \
    --keep GITHUB_JOB \
    --keep GITHUB_ACTIONS \
    --keep GITHUB_OUTPUT \
    --keep GITHUB_ENV \
    --keep GITHUB_PATH \
    --keep GITHUB_STEP_SUMMARY \
    --keep GITHUB_WORKSPACE \
    --keep GITHUB_EVENT_NAME \
    --keep GITHUB_EVENT_PATH \
    --keep KANDELO_NIX_BIN \
    --keep SYNTH_BASE_SHA \
    --keep SYNTH_HEAD_SHA \
    --keep SYNTHETIC_MERGE_SHA \
    --keep RUNNER_TEMP \
    --keep RUNNER_OS \
    --keep RUNNER_ARCH \
    --keep RUNNER_TOOL_CACHE \
    --keep RUNNER_NAME \
    --keep RUNNER_DEBUG \
    --keep WASM_POSIX_DEP_TARGET_ARCH \
    --keep WASM_POSIX_DEP_OUT_DIR \
    --keep WASM_POSIX_DEP_NAME \
    --keep WASM_POSIX_DEP_VERSION \
    --keep WASM_POSIX_USE_PR_STAGING \
    --keep WASM_POSIX_FETCH_SKIP_PKGS \
    --keep WASM_POSIX_SYSROOT \
    --keep WASM_POSIX_LLVM_DIR \
    --keep WASM_POSIX_LOCAL_BUILD_JOBS \
    --accept-flake-config
)

# Pin the dev-shell closure with a durable GC root so a background Nix
# garbage collection cannot evict declared build tools mid-build. Without a
# root, `nix develop` holds only a transient root for its own process; when
# a GC fires during a long build (Determinate Nix runs one periodically),
# it deletes an unrooted tool's store path, which surfaces as an
# intermittent "env: 'zip': No such file or directory" (or help2man, ...)
# on one package while a sibling in the same run succeeds. A `--profile` is
# a stable indirect GC root (registered under /nix/var/nix/gcroots/auto),
# updated atomically in place, so it also stops re-realizing the closure on
# every entry. Best-effort: if the profile directory is not writable, fall
# back to the unrooted behavior rather than failing the shell entry.
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
gcroot_args=()
gcroot_dir="${KANDELO_DEV_SHELL_PROFILE_DIR:-$repo_root/.nix-dev-shell}"
if mkdir -p "$gcroot_dir" 2>/dev/null && [ -w "$gcroot_dir" ]; then
    gcroot_args=(--profile "$gcroot_dir/profile")
fi

# Realizing the shell closure is split out from running the user's command
# so the source-bootstrap watchdog below only ever inspects Nix's own
# substitution output. Once `--command "${dev_command[@]}"` is running,
# arbitrary build output shares the same stream and would produce false
# positives. `true` needs no PATH repair, so the warm phase deliberately
# does not go through `dev_command`. The warm phase carries the `--profile`
# root; it persists for the unrooted `exec` below, so the whole invocation
# stays protected without churning a second profile generation per run.
# `${#arr[@]}` is used instead of expanding a possibly-empty array so the
# fallback path stays safe under `set -u` on macOS's bash 3.2.
if [ "${#gcroot_args[@]}" -gt 0 ]; then
    warm=("${nix_develop[@]}" "${gcroot_args[@]}" --command true)
else
    warm=("${nix_develop[@]}" --command true)
fi

is_transient_nix_fetch_failure() {
    local log_file="$1"

    # Nix already retries individual downloads quickly. Wrap the whole
    # shell entry with slower backoff for short GitHub archive outages.
    grep -Eq "unable to download 'https://(api\\.)?github\\.com/" "$log_file" &&
        grep -Eq 'HTTP error 5[0-9][0-9]|This page is taking too long to load|Bad Gateway|Service Unavailable' "$log_file"
}

is_substituter_failure() {
    local log_file="$1"

    grep -Eq "disabling binary cache 'https?://[^']+'" "$log_file" ||
        grep -q 'there is no substituter that can build it' "$log_file"
}

# When a NAR download fails, Nix disables that binary cache for 60 seconds
# (hardcoded in HttpBinaryCacheStore; not a nix.conf setting). Store paths
# it cannot substitute during that window are then built from source. For
# this flake that means bootstrapping stdenv: bootstrap-tools, binutils,
# gcc, glibc. It never fails -- it just runs for hours. Observed on
# Automattic/kandelo run 29001115976, where one matrix job burned 5h52m
# before hitting the GitHub job ceiling.
#
# None of this is a Kandelo toolchain input. Any of these names appearing
# after `building '` means the substituters are unhealthy, not that we have
# work to do, so abort and retry against a recovered cache rather than
# proving the point over six hours.
#
# Set WASM_POSIX_ALLOW_SOURCE_BOOTSTRAP=1 to opt out (e.g. deliberately
# bootstrapping on a system cache.nixos.org does not serve).
source_bootstrap_re="building '/nix/store/[^']*-(bootstrap-tools|stdenv-(linux|darwin)|glibc-[0-9]|gcc-[0-9]|binutils-[0-9])"

watch_for_source_bootstrap() {
    local log_file="$1" nix_pid="$2" flag_file="$3"

    while kill -0 "$nix_pid" 2>/dev/null; do
        if grep -Eq "$source_bootstrap_re" "$log_file" 2>/dev/null; then
            : >"$flag_file"
            echo "dev-shell.sh: nix is rebuilding the toolchain from source; the binary cache is unhealthy. Aborting." >&2
            # The client owns the build; killing it makes nix-daemon drop
            # the work. A fresh connection also gets a fresh cache state,
            # which is what clears the 60s disable.
            pkill -TERM -P "$nix_pid" 2>/dev/null || true
            kill -TERM "$nix_pid" 2>/dev/null || true
            return 0
        fi
        sleep 2
    done
}

attempt=1
max_attempts="${WASM_POSIX_DEV_SHELL_ATTEMPTS:-3}"

while true; do
    log_file="$(mktemp)"
    flag_file="$(mktemp -u)"
    watchdog_pid=""

    set +e
    "${warm[@]}" > >(tee "$log_file") 2>&1 &
    nix_pid=$!
    if [ -z "${WASM_POSIX_ALLOW_SOURCE_BOOTSTRAP:-}" ]; then
        watch_for_source_bootstrap "$log_file" "$nix_pid" "$flag_file" &
        watchdog_pid=$!
    fi
    wait "$nix_pid"
    rc=$?
    set -e

    if [ -n "$watchdog_pid" ]; then
        kill "$watchdog_pid" 2>/dev/null || true
        wait "$watchdog_pid" 2>/dev/null || true
    fi

    if [ -e "$flag_file" ]; then
        reason="binary cache unhealthy (nix fell back to building the toolchain from source)"
        # Long enough for Nix's 60s cache disable to lapse. A shorter
        # sleep just re-enters the same disabled-cache window.
        delay=$((90 * attempt))
    elif [ "$rc" -eq 0 ]; then
        rm -f "$log_file" "$flag_file"
        break
    elif is_substituter_failure "$log_file"; then
        reason="binary cache unhealthy (substitution failed)"
        delay=$((90 * attempt))
    elif is_transient_nix_fetch_failure "$log_file"; then
        reason="transient GitHub flake fetch failure"
        delay=$((5 * attempt))
    else
        rm -f "$log_file" "$flag_file"
        exit "$rc"
    fi

    rm -f "$log_file" "$flag_file"

    if [ "$attempt" -ge "$max_attempts" ]; then
        echo "dev-shell.sh: ${reason}; giving up after ${max_attempts} attempts." >&2
        exit "${rc:-1}"
    fi

    echo "dev-shell.sh: ${reason}; retrying nix develop in ${delay}s (attempt ${attempt}/${max_attempts})." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
done

# Closure is realized, so this cannot trip the watchdog. Running it
# unwrapped also keeps stdout a tty for `dev-shell.sh bash`.
exec "${nix_develop[@]}" --command "${dev_command[@]}"
