#!/usr/bin/env bash
# Contract tests for caller-owned package source, work, and output roots.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
fail() {
    echo "test-package-build-roots.sh: $*" >&2
    exit 1
}

test_fbdoom_sealed_chocolate_doom_input() (
    set -euo pipefail

    local test_root primary_source sealed_input source_archive work_root out_root
    local fake_bin make_sentinel stdout_file stderr_file missing_work missing_out
    test_root="$(mktemp -d)"
    test_root="$(cd "$test_root" && pwd -P)"
    trap 'chmod -R u+w "$test_root" 2>/dev/null || true; rm -rf "$test_root"' EXIT
    primary_source="$test_root/primary-source"
    sealed_input="$test_root/chocolate-doom"
    source_archive="$test_root/fbdoom-source.tar.gz"
    work_root="$test_root/work"
    out_root="$test_root/out"
    fake_bin="$test_root/fake-bin"
    make_sentinel="$test_root/make-was-called"
    stdout_file="$test_root/fbdoom.stdout"
    stderr_file="$test_root/fbdoom.stderr"
    missing_work="$test_root/missing-work"
    missing_out="$test_root/missing-out"

    mkdir -p "$primary_source/fbdoom" "$sealed_input/opl" \
        "$sealed_input/src" "$work_root" "$out_root" "$fake_bin" \
        "$missing_work" "$missing_out"
    printf 'resolver-owned primary source\n' >"$primary_source/fbdoom/primary.c"
    printf 'resolver-owned archive evidence\n' >"$source_archive"
    local file
    for file in opl.c opl.h opl3.c opl3.h opl_internal.h opl_queue.c opl_queue.h; do
        printf 'sealed chocolate-doom %s\n' "$file" >"$sealed_input/opl/$file"
    done
    for file in mus2mid.c mus2mid.h midifile.c midifile.h; do
        printf 'sealed chocolate-doom %s\n' "$file" >"$sealed_input/src/$file"
    done
    chmod -R a-w "$primary_source" "$sealed_input"

    # Patch application is below the contract under test. Keep the real build
    # script and filesystem behavior, but stop at the first compiler boundary.
    cat >"$fake_bin/git" <<'FBDOOM_FAKE_GIT'
#!/usr/bin/env bash
exit 0
FBDOOM_FAKE_GIT
    cat >"$fake_bin/make" <<'FBDOOM_FAKE_MAKE'
#!/usr/bin/env bash
: >"$FBDOOM_TEST_MAKE_SENTINEL"
exit 89
FBDOOM_FAKE_MAKE
    chmod +x "$fake_bin/git" "$fake_bin/make"

    if env -u WASM_POSIX_BUILD_GIT_CHOCOLATE_DOOM_DIR \
        -u WASM_POSIX_BUILD_GIT_CHOCOLATE_DOOM_COMMIT \
        PATH="$fake_bin:$PATH" \
        WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
        WASM_POSIX_DEP_SOURCE_ARCHIVE="$source_archive" \
        WASM_POSIX_DEP_SOURCE_DIR="$primary_source" \
        WASM_POSIX_DEP_WORK_DIR="$missing_work" \
        WASM_POSIX_DEP_OUT_DIR="$missing_out" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        bash "$REPO_ROOT/packages/registry/fbdoom/build-fbdoom.sh" \
        >"$stdout_file" 2>"$stderr_file"; then
        fail "fbdoom accepted a missing SourceOnly chocolate-doom Git input"
    fi
    grep -F "requires build.toml git input chocolate_doom" "$stderr_file" >/dev/null ||
        fail "fbdoom did not explain its missing SourceOnly chocolate-doom Git input"
    [ ! -e "$missing_work/chocolate-doom-src" ] ||
        fail "fbdoom mutated work state before rejecting its missing Git input"

    rm -f "$stdout_file" "$stderr_file"
    if PATH="$fake_bin:$PATH" \
        FBDOOM_TEST_MAKE_SENTINEL="$make_sentinel" \
        WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
        WASM_POSIX_DEP_SOURCE_ARCHIVE="$source_archive" \
        WASM_POSIX_DEP_SOURCE_DIR="$primary_source" \
        WASM_POSIX_DEP_WORK_DIR="$work_root" \
        WASM_POSIX_DEP_OUT_DIR="$out_root" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        WASM_POSIX_BUILD_GIT_CHOCOLATE_DOOM_DIR="$sealed_input" \
        WASM_POSIX_BUILD_GIT_CHOCOLATE_DOOM_COMMIT=35fb1372d10756ca27eca05665bd8a7cebc71c05 \
        bash "$REPO_ROOT/packages/registry/fbdoom/build-fbdoom.sh" \
        >"$stdout_file" 2>"$stderr_file"; then
        fail "fbdoom fixture unexpectedly crossed its fake compiler boundary"
    fi
    if [ ! -e "$make_sentinel" ]; then
        sed -n '1,160p' "$stderr_file" >&2
        fail "fbdoom did not reach its compiler after importing the sealed Git input"
    fi
    cmp "$sealed_input/opl/opl.c" "$work_root/chocolate-doom-src/opl/opl.c" >/dev/null ||
        fail "fbdoom did not import chocolate-doom from the sealed Git input"
    [ -z "$(find "$work_root/chocolate-doom-src" ! -type l ! -perm -u=w -print -quit)" ] ||
        fail "fbdoom's copied chocolate-doom work tree is not owner-writable"
    [ -z "$(find "$sealed_input" ! -type l -perm -u=w -print -quit)" ] ||
        fail "fbdoom mutated the sealed chocolate-doom Git input"
)

if [ "${KANDELO_PACKAGE_BUILD_ROOTS_TEST_FOCUS:-}" = "fbdoom-git-input" ]; then
    test_fbdoom_sealed_chocolate_doom_input
    echo "test-package-build-roots.sh: fbdoom sealed Git-input contract ok"
    exit 0
fi

run_spidermonkey_to_sysroot_gate() (
    set -euo pipefail

    local test_root="$1" stdout_file="$2"
    shift 2

    # The sysroot gate is the first check below the host SDK selection, so an
    # empty sysroot stops the build there without running a compiler. The
    # SourceOnly staging gate sits above the SDK selection and would exit
    # first, so this contract is only observable outside that policy.
    if env -u WASM_POSIX_RESOLUTION_POLICY "$@" \
        WASM_POSIX_SYSROOT="$test_root/no-sysroot" \
        WASM_POSIX_DEP_WORK_DIR="$test_root/work" \
        WASM_POSIX_DEP_OUT_DIR="$test_root/out" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
        bash "$REPO_ROOT/packages/registry/spidermonkey/build-spidermonkey.sh" \
        >"$stdout_file" 2>"$test_root/stderr"; then
        fail "SpiderMonkey ran past its missing sysroot"
    fi
    grep -F "sysroot not found" "$test_root/stderr" >/dev/null ||
        fail "SpiderMonkey stopped before selecting its host macOS SDK"
)

test_spidermonkey_host_macos_sdk() (
    set -euo pipefail
    [ "$(uname -s)" = "Darwin" ] || return 0

    local test_root selected override
    test_root="$(mktemp -d)"
    test_root="$(cd "$test_root" && pwd -P)"
    trap 'rm -rf "$test_root"' EXIT
    mkdir -p "$test_root/no-sysroot"

    run_spidermonkey_to_sysroot_gate "$test_root" "$test_root/selected.stdout" \
        -u WASM_POSIX_MACOS_SDK_DIR
    selected="$(sed -n 's/^==> Using macOS SDK //p' "$test_root/selected.stdout")"
    [ -n "$selected" ] ||
        fail "SpiderMonkey did not report the host macOS SDK it selected"
    case "$selected" in
    /nix/store/*)
        fail "SpiderMonkey selected the dev shell's nix macOS SDK: $selected"
        ;;
    esac
    # mozbuild links host build scripts through Apple's cc with -nodefaultlibs,
    # so NIX_LDFLAGS never applies and -liconv has to come from the SDK itself.
    [ -e "$selected/usr/lib/libiconv.tbd" ] ||
        fail "SpiderMonkey's host macOS SDK carries no libiconv: $selected"

    override="$test_root/override-sdk"
    mkdir -p "$override"
    run_spidermonkey_to_sysroot_gate "$test_root" "$test_root/override.stdout" \
        WASM_POSIX_MACOS_SDK_DIR="$override"
    [ "$(sed -n 's/^==> Using macOS SDK //p' "$test_root/override.stdout")" = "$override" ] ||
        fail "SpiderMonkey ignored the caller's WASM_POSIX_MACOS_SDK_DIR"
)

test_spidermonkey_host_macos_sdk
if [ "${KANDELO_PACKAGE_BUILD_ROOTS_TEST_FOCUS:-}" = "spidermonkey-host-sdk" ]; then
    echo "test-package-build-roots.sh: SpiderMonkey host macOS SDK contract ok"
    exit 0
fi

netcat_script="$REPO_ROOT/packages/registry/netcat/build-netcat.sh"
if grep -F 'automake --print-libdir' "$netcat_script" >/dev/null; then
    fail "netcat executes the relocated Automake wrapper to locate support data"
fi
grep -F 'AUTOMAKE_PREFIX=' "$netcat_script" >/dev/null ||
    fail "netcat does not derive the declared Automake keg from its executable"
grep -F 'automake_aux_dirs' "$netcat_script" >/dev/null ||
    fail "netcat does not require one exact Automake support-data directory"
if [ "${KANDELO_PACKAGE_BUILD_ROOTS_TEST_FOCUS:-}" = "netcat-automake-aux" ]; then
    echo "test-package-build-roots.sh: netcat Automake support-data contract ok"
    exit 0
fi

case "${KANDELO_PACKAGE_BUILD_ROOTS_TEST_FOCUS:-}" in
source-dependency|private-sysroot) ;;
*)
    # The program index is a generated artifact (gitignored); generate it here
    # so this build-roots test runs against an up-to-date projection.
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        build-deps program-index \
        --source-repo-root "$REPO_ROOT" \
        "$REPO_ROOT/packages/registry" \
        "$REPO_ROOT/packages/registry/program-packages.json"
    ;;
esac

TMP_ROOT="$(mktemp -d)"
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
cleanup() {
    chmod -R u+w "$TMP_ROOT" 2>/dev/null || true
    rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

tree_digest() {
    local root="$1"
    tar cf - -C "$root" . | shasum -a 256 | awk '{print $1}'
}

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"

source_dep_dash="$TMP_ROOT/source-dependency-dash"
source_dep_underscore="$TMP_ROOT/source-dependency-underscore"
source_dep_punctuation="$TMP_ROOT/source-dependency-punctuation"
source_dep_unicode="$TMP_ROOT/source-dependency-unicode"
mkdir -p "$source_dep_dash" "$source_dep_underscore" \
    "$source_dep_punctuation" "$source_dep_unicode"

source_dep_dash_var=WASM_POSIX_DEP_K_666F6F2D626172_SRC_DIR
source_dep_underscore_var=WASM_POSIX_DEP_K_666F6F5F626172_SRC_DIR
source_dep_punctuation_var=WASM_POSIX_DEP_K_706B672E6E616D65_SRC_DIR
source_dep_unicode_var=WASM_POSIX_DEP_K_C3A9_SRC_DIR
printf -v "$source_dep_dash_var" '%s' "$source_dep_dash"
printf -v "$source_dep_underscore_var" '%s' "$source_dep_underscore"
printf -v "$source_dep_punctuation_var" '%s' "$source_dep_punctuation"
printf -v "$source_dep_unicode_var" '%s' "$source_dep_unicode"
export "${source_dep_dash_var?}" "${source_dep_underscore_var?}"
export "${source_dep_punctuation_var?}" "${source_dep_unicode_var?}"

WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_RESOLUTION_POLICY
[ "$(kandelo_package_source_dependency_dir foo-bar)" = "$source_dep_dash" ] ||
    fail "source-only dependency lookup changed the injective dash name"
[ "$(kandelo_package_source_dependency_dir foo_bar)" = "$source_dep_underscore" ] ||
    fail "source-only dependency lookup changed the injective underscore name"
[ "$(kandelo_package_source_dependency_dir pkg.name)" = "$source_dep_punctuation" ] ||
    fail "source-only dependency lookup changed punctuation bytes"
[ "$(kandelo_package_source_dependency_dir 'é')" = "$source_dep_unicode" ] ||
    fail "source-only dependency lookup changed UTF-8 bytes"

legacy_source_var=WASM_POSIX_DEP_FOO_BAR_SRC_DIR
printf -v "$legacy_source_var" '%s' "$source_dep_underscore"
export "${legacy_source_var?}"
[ "$(kandelo_package_source_dependency_dir foo-bar)" = "$source_dep_dash" ] ||
    fail "source-only dependency lookup accepted the lossy legacy alias"
unset "$source_dep_dash_var"
err="$TMP_ROOT/source-dependency-source-only-legacy.err"
if kandelo_package_source_dependency_dir foo-bar > /dev/null 2>"$err"; then
    fail "source-only dependency lookup fell back to its legacy alias"
fi
grep -F "$source_dep_dash_var" "$err" >/dev/null ||
    fail "source-only missing dependency did not name its exact variable"

unset WASM_POSIX_RESOLUTION_POLICY
printf -v "$source_dep_dash_var" '%s' "$source_dep_dash"
export "${source_dep_dash_var?}"
[ "$(kandelo_package_source_dependency_dir foo-bar)" = "$source_dep_underscore" ] ||
    fail "default dependency lookup did not preserve its legacy alias"
unset "$legacy_source_var"
err="$TMP_ROOT/source-dependency-default-injective.err"
if kandelo_package_source_dependency_dir foo-bar > /dev/null 2>"$err"; then
    fail "default dependency lookup accepted the source-only injective alias"
fi
grep -F "$legacy_source_var" "$err" >/dev/null ||
    fail "default missing dependency did not name its legacy variable"

assert_source_dependency_rejected() {
    local label="$1"
    local package_name="$2"
    local expected="$3"
    local err_file="$TMP_ROOT/source-dependency-$label.err"
    if kandelo_package_source_dependency_dir "$package_name" \
        > /dev/null 2>"$err_file"; then
        fail "source dependency lookup accepted $label"
    fi
    grep -F "$expected" "$err_file" >/dev/null ||
        fail "source dependency $label rejection was not explained"
}

WASM_POSIX_RESOLUTION_POLICY=source-only-v1
export WASM_POSIX_RESOLUTION_POLICY
assert_source_dependency_rejected empty-name "" "package name must not be empty"
missing_source_var=WASM_POSIX_DEP_K_6D697373696E67_SRC_DIR
assert_source_dependency_rejected missing-value missing "$missing_source_var"
empty_source_var=WASM_POSIX_DEP_K_656D707479_SRC_DIR
printf -v "$empty_source_var" '%s' ""
export "${empty_source_var?}"
assert_source_dependency_rejected empty-value empty "$empty_source_var"
file_source_var=WASM_POSIX_DEP_K_66696C65_SRC_DIR
source_dep_file="$TMP_ROOT/source-dependency-file"
printf 'not a directory\n' >"$source_dep_file"
printf -v "$file_source_var" '%s' "$source_dep_file"
export "${file_source_var?}"
assert_source_dependency_rejected non-directory file "must be a real directory"
relative_source_var=WASM_POSIX_DEP_K_72656C6174697665_SRC_DIR
printf -v "$relative_source_var" '%s' relative
export "${relative_source_var?}"
assert_source_dependency_rejected relative relative "must be an absolute path"

source_dep_injection_sentinel="$TMP_ROOT/source-dependency-eval-injection"
hostile_source_name="x\$(touch $source_dep_injection_sentinel)"
assert_source_dependency_rejected no-eval "$hostile_source_name" \
    "source dependency variable"
[ ! -e "$source_dep_injection_sentinel" ] ||
    fail "source dependency lookup evaluated hostile package-name text"
unset WASM_POSIX_RESOLUTION_POLICY

if [ "${KANDELO_PACKAGE_BUILD_ROOTS_TEST_FOCUS:-}" = "source-dependency" ]; then
    echo "test-package-build-roots.sh: source dependency contract ok"
    exit 0
fi

private_work="$TMP_ROOT/private-sysroot-work"
private_out="$TMP_ROOT/private-sysroot-out"
private_source="$TMP_ROOT/private-sysroot-source"
private_sdk="$TMP_ROOT/private-sysroot-sdk"
private_libcxx="$TMP_ROOT/private-sysroot-libcxx"
mkdir -p "$private_work" "$private_out" "$private_source" \
    "$private_sdk/include" "$private_sdk/lib" \
    "$private_libcxx/include/c++/v1" "$private_libcxx/lib"
printf 'sdk header\n' >"$private_sdk/include/sdk.h"
printf 'sdk archive\n' >"$private_sdk/lib/libc.a"
printf 'libc++ header\n' >"$private_libcxx/include/c++/v1/memory"
printf 'libc++ archive\n' >"$private_libcxx/lib/libc++.a"
chmod -R a-w "$private_sdk" "$private_libcxx" "$private_source"

WASM_POSIX_DEP_WORK_DIR="$private_work"
WASM_POSIX_DEP_OUT_DIR="$private_out"
WASM_POSIX_DEP_SOURCE_DIR="$private_source"
WASM_POSIX_DEP_LIBCXX_DIR="$private_libcxx"
export WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR \
    WASM_POSIX_DEP_SOURCE_DIR WASM_POSIX_DEP_LIBCXX_DIR

private_sdk_before="$(tree_digest "$private_sdk")"
private_libcxx_before="$(tree_digest "$private_libcxx")"
private_source_before="$(tree_digest "$private_source")"
private_sysroot="$(kandelo_package_prepare_private_sysroot icu "$private_sdk" libcxx)"
case "$private_sysroot/" in
    "$private_work/"*) ;;
    *) fail "private sysroot escaped the resolver work root" ;;
esac
[ -f "$private_sysroot/include/sdk.h" ] ||
    fail "private sysroot omitted the SDK seed"
[ -f "$private_sysroot/include/c++/v1/memory" ] ||
    fail "private sysroot omitted a declared dependency overlay"
[ -f "$private_sysroot/lib/libc++.a" ] ||
    fail "private sysroot omitted the declared dependency archive"
printf 'private replacement\n' >"$private_sysroot/include/sdk.h"
printf 'private addition\n' >"$private_sysroot/lib/package-local.a"
[ "$(tree_digest "$private_sdk")" = "$private_sdk_before" ] ||
    fail "private sysroot preparation mutated the SDK seed"
[ "$(tree_digest "$private_libcxx")" = "$private_libcxx_before" ] ||
    fail "private sysroot preparation mutated a dependency output"
[ "$(tree_digest "$private_source")" = "$private_source_before" ] ||
    fail "private sysroot preparation mutated the sealed source"

concurrent_one_file="$TMP_ROOT/private-sysroot-concurrent-one"
concurrent_two_file="$TMP_ROOT/private-sysroot-concurrent-two"
kandelo_package_prepare_private_sysroot concurrent "$private_sdk" libcxx \
    >"$concurrent_one_file" &
concurrent_one_pid=$!
kandelo_package_prepare_private_sysroot concurrent "$private_sdk" libcxx \
    >"$concurrent_two_file" &
concurrent_two_pid=$!
wait "$concurrent_one_pid"
wait "$concurrent_two_pid"
concurrent_one="$(cat "$concurrent_one_file")"
concurrent_two="$(cat "$concurrent_two_file")"
[ "$concurrent_one" != "$concurrent_two" ] ||
    fail "concurrent private sysroots shared one mutable destination"
printf 'first only\n' >"$concurrent_one/lib/first-only.a"
[ ! -e "$concurrent_two/lib/first-only.a" ] ||
    fail "concurrent private sysroots were not isolated"

assert_private_sysroot_rejected() {
    local label="$1"
    local expected="$2"
    shift 2
    local err_file="$TMP_ROOT/private-sysroot-$label.err"
    if kandelo_package_prepare_private_sysroot "$@" \
        > /dev/null 2>"$err_file"; then
        fail "private sysroot accepted $label"
    fi
    grep -F "$expected" "$err_file" >/dev/null ||
        fail "private sysroot $label rejection was not explained"
}

assert_private_sysroot_rejected escaping-name "stable identifier" \
    ../escape "$private_sdk" libcxx
assert_private_sysroot_rejected missing-dependency \
    "WASM_POSIX_DEP_ZLIB_DIR" missing "$private_sdk" zlib

private_bad_sdk="$TMP_ROOT/private-sysroot-bad-sdk"
private_outside="$TMP_ROOT/private-sysroot-outside"
mkdir -p "$private_bad_sdk" "$private_outside"
printf 'outside sentinel\n' >"$private_outside/sentinel"
ln -s "$private_outside" "$private_bad_sdk/escape"
assert_private_sysroot_rejected sdk-symlink "contains a symlink" \
    bad-sdk "$private_bad_sdk"
[ "$(cat "$private_outside/sentinel")" = "outside sentinel" ] ||
    fail "private sysroot followed an SDK symlink escape"

private_bad_dep="$TMP_ROOT/private-sysroot-bad-dependency"
mkdir -p "$private_bad_dep"
ln -s "$private_outside/sentinel" "$private_bad_dep/escape"
WASM_POSIX_DEP_ZLIB_DIR="$private_bad_dep"
export WASM_POSIX_DEP_ZLIB_DIR
assert_private_sysroot_rejected dependency-symlink "contains a symlink" \
    bad-dependency "$private_sdk" zlib
[ "$(cat "$private_outside/sentinel")" = "outside sentinel" ] ||
    fail "private sysroot followed a dependency symlink escape"

private_fifo_dep="$TMP_ROOT/private-sysroot-fifo-dependency"
mkdir -p "$private_fifo_dep"
mkfifo "$private_fifo_dep/pipe"
WASM_POSIX_DEP_ZLIB_DIR="$private_fifo_dep"
assert_private_sysroot_rejected dependency-special "contains a special entry" \
    fifo-dependency "$private_sdk" zlib

private_nested_sdk="$private_work/sdk"
mkdir -p "$private_nested_sdk"
assert_private_sysroot_rejected overlapping-sdk \
    "must not overlap WASM_POSIX_DEP_WORK_DIR" \
    overlapping "$private_nested_sdk"

private_work_alias="$TMP_ROOT/private-sysroot-work-alias"
ln -s "$private_work" "$private_work_alias"
WASM_POSIX_DEP_WORK_DIR="$private_work_alias"
assert_private_sysroot_rejected aliased-work \
    "WASM_POSIX_DEP_WORK_DIR must be a real directory" \
    aliased-work "$private_sdk"
WASM_POSIX_DEP_WORK_DIR="$private_work"

private_nested_source="$private_work/source-overlap"
mkdir -p "$private_nested_source"
WASM_POSIX_DEP_SOURCE_DIR="$private_nested_source"
assert_private_sysroot_rejected overlapping-source \
    "WASM_POSIX_DEP_WORK_DIR must not overlap WASM_POSIX_DEP_SOURCE_DIR" \
    overlapping-source "$private_sdk"
WASM_POSIX_DEP_SOURCE_DIR="$private_source"

if [ "${KANDELO_PACKAGE_BUILD_ROOTS_TEST_FOCUS:-}" = "private-sysroot" ]; then
    echo "test-package-build-roots.sh: private sysroot contract ok"
    exit 0
fi

direct_work="$TMP_ROOT/direct-work"
unset WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR \
    WASM_POSIX_DEP_SOURCE_DIR WASM_POSIX_DEP_TARGET_ARCH
kandelo_package_prepare_build_roots "$direct_work" wasm32
[ "$KANDELO_PACKAGE_WORK_DIR" = "$(cd "$direct_work" && pwd -P)" ] ||
    fail "direct developer work-root fallback changed"
[ -z "$KANDELO_PACKAGE_OUT_DIR" ] ||
    fail "direct developer build unexpectedly acquired an output root"
kandelo_package_select_source_root "$REPO_ROOT"
[ "$KANDELO_PACKAGE_SOURCE_ROOT" = "$(cd "$REPO_ROOT" && pwd -P)" ] ||
    fail "direct developer source-root fallback changed"

work_root="$TMP_ROOT/caller-work"
out_root="$TMP_ROOT/caller-out"
WASM_POSIX_DEP_WORK_DIR="$work_root"
WASM_POSIX_DEP_OUT_DIR="$out_root"
WASM_POSIX_DEP_TARGET_ARCH=wasm32
kandelo_package_prepare_build_roots "$direct_work" wasm32
[ "$KANDELO_PACKAGE_WORK_DIR" = "$(cd "$work_root" && pwd -P)" ] ||
    fail "caller work root was not selected"
[ "$KANDELO_PACKAGE_OUT_DIR" = "$(cd "$out_root" && pwd -P)" ] ||
    fail "caller output root was not selected"

err="$TMP_ROOT/invalid-arch.err"
if (WASM_POSIX_DEP_TARGET_ARCH=wasm64
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "unsupported package architecture was accepted"
fi
grep -F "built for wasm32 only, got wasm64" "$err" >/dev/null ||
    fail "unsupported package architecture was not explained"

real_dir="$TMP_ROOT/real-dir"
linked_dir="$TMP_ROOT/linked-dir"
mkdir -p "$real_dir"
ln -s "$real_dir" "$linked_dir"
err="$TMP_ROOT/symlink-work.err"
if (WASM_POSIX_DEP_WORK_DIR="$linked_dir"
    WASM_POSIX_DEP_OUT_DIR=
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "symlink work root was accepted"
fi
grep -F "WASM_POSIX_DEP_WORK_DIR must be a real directory" "$err" >/dev/null ||
    fail "symlink work-root rejection was not explained"

err="$TMP_ROOT/symlink-out.err"
if (WASM_POSIX_DEP_WORK_DIR="$work_root"
    WASM_POSIX_DEP_OUT_DIR="$linked_dir"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "symlink output root was accepted"
fi
grep -F "WASM_POSIX_DEP_OUT_DIR must be a real directory" "$err" >/dev/null ||
    fail "symlink output-root rejection was not explained"

overlap_work="$TMP_ROOT/overlap"
overlap_out="$overlap_work/out"
mkdir -p "$overlap_work"
err="$TMP_ROOT/overlap.err"
if (WASM_POSIX_DEP_WORK_DIR="$overlap_work"
    WASM_POSIX_DEP_OUT_DIR="$overlap_out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "overlapping caller work/output roots were accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "overlapping caller roots were not explained"

overlap_out_parent="$TMP_ROOT/overlap-out-parent"
overlap_work_child="$overlap_out_parent/work"
mkdir -p "$overlap_work_child"
err="$TMP_ROOT/reverse-work-out-overlap.err"
if (WASM_POSIX_DEP_WORK_DIR="$overlap_work_child"
    WASM_POSIX_DEP_OUT_DIR="$overlap_out_parent"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "output root containing the work root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "reverse work/output overlap was not explained"

source_contains_work="$TMP_ROOT/source-contains-work"
mkdir -p "$source_contains_work"
err="$TMP_ROOT/source-work-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$source_contains_work"
    WASM_POSIX_DEP_WORK_DIR="$source_contains_work/work"
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/source-work-out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "source root containing the work root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "source/work overlap was not explained"
[ ! -e "$source_contains_work/work" ] ||
    fail "source/work overlap mutated the caller source before rejection"

work_contains_source="$TMP_ROOT/work-contains-source"
mkdir -p "$work_contains_source/source"
err="$TMP_ROOT/work-source-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$work_contains_source/source"
    WASM_POSIX_DEP_WORK_DIR="$work_contains_source"
    WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/work-source-out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "work root containing the source root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "reverse source/work overlap was not explained"

source_contains_out="$TMP_ROOT/source-contains-out"
mkdir -p "$source_contains_out"
err="$TMP_ROOT/source-out-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$source_contains_out"
    WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/source-out-work"
    WASM_POSIX_DEP_OUT_DIR="$source_contains_out/out"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "source root containing the output root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "source/output overlap was not explained"
[ ! -e "$source_contains_out/out" ] ||
    fail "source/output overlap mutated the caller source before rejection"

out_contains_source="$TMP_ROOT/out-contains-source"
mkdir -p "$out_contains_source/source"
err="$TMP_ROOT/out-source-overlap.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$out_contains_source/source"
    WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/out-source-work"
    WASM_POSIX_DEP_OUT_DIR="$out_contains_source"
    kandelo_package_prepare_build_roots "$direct_work" wasm32) 2>"$err"; then
    fail "output root containing the source root was accepted"
fi
grep -F "must not overlap" "$err" >/dev/null ||
    fail "reverse source/output overlap was not explained"

source_root="$TMP_ROOT/source"
mkdir -p "$source_root/subdir"
printf 'caller-verified source\n' >"$source_root/subdir/payload.txt"
chmod -R a-w "$source_root"
source_before="$(tree_digest "$source_root")"

WASM_POSIX_DEP_SOURCE_DIR="$source_root"
kandelo_package_select_source_root "$REPO_ROOT"
[ "$KANDELO_PACKAGE_SOURCE_ROOT" = "$(cd "$source_root" && pwd -P)" ] ||
    fail "caller source root was not selected"

verified_dest="$TMP_ROOT/verified-dest"
kandelo_package_stage_verified_source fixture "$verified_dest" "$source_root" \
    "https://invalid.example/verified-dir-must-win.tar.gz" "not-a-hash" "$work_root"
cmp -s "$source_root/subdir/payload.txt" "$verified_dest/subdir/payload.txt" ||
    fail "verified source directory was not copied exactly"
[ "$(tree_digest "$source_root")" = "$source_before" ] ||
    fail "caller-verified source tree was mutated"

source_link="$TMP_ROOT/source-link"
ln -s "$source_root" "$source_link"
err="$TMP_ROOT/source-link.err"
if (WASM_POSIX_DEP_SOURCE_DIR="$source_link"
    kandelo_package_select_source_root "$REPO_ROOT") 2>"$err"; then
    fail "symlink source root was accepted"
fi
grep -F "WASM_POSIX_DEP_SOURCE_DIR must be a real directory" "$err" >/dev/null ||
    fail "symlink source-root rejection was not explained"

archive_parent="$TMP_ROOT/archive-parent"
mkdir -p "$archive_parent/upstream-1.0"
printf 'archive-selected source\n' >"$archive_parent/upstream-1.0/archive.txt"
archive="$TMP_ROOT/source.tar.gz"
tar czf "$archive" -C "$archive_parent" upstream-1.0
archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"

fake_bin="$TMP_ROOT/fake-network-bin"
fake_curl_sentinel="$TMP_ROOT/fake-curl-called"
mkdir -p "$fake_bin"
cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
: >"$KANDELO_FAKE_CURL_SENTINEL"
exit 97
FAKE_CURL
chmod +x "$fake_bin/curl"

source_only_work="$TMP_ROOT/source-only-work"
source_only_out="$TMP_ROOT/source-only-out"
source_only_dest="$source_only_work/staged-source"
mkdir -p "$source_only_work" "$source_only_out"
source_only_archive_before="$(shasum -a 256 "$archive" | awk '{print $1}')"
source_only_source_before="$(tree_digest "$source_root")"
(
    PATH="$fake_bin:$PATH"
    KANDELO_FAKE_CURL_SENTINEL="$fake_curl_sentinel"
    WASM_POSIX_RESOLUTION_POLICY=source-only-v1
    WASM_POSIX_DEP_SOURCE_ARCHIVE="$archive"
    WASM_POSIX_DEP_SOURCE_DIR="$source_root"
    WASM_POSIX_DEP_WORK_DIR="$source_only_work"
    WASM_POSIX_DEP_OUT_DIR="$source_only_out"
    export PATH KANDELO_FAKE_CURL_SENTINEL WASM_POSIX_RESOLUTION_POLICY
    export WASM_POSIX_DEP_SOURCE_ARCHIVE WASM_POSIX_DEP_SOURCE_DIR
    export WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR
    kandelo_package_stage_verified_source source-only "$source_only_dest" \
        "$source_root" "https://invalid.example/must-not-download.tar.gz" \
        "$archive_sha" "$source_only_work"
)
[ ! -e "$fake_curl_sentinel" ] ||
    fail "valid source-only staging invoked curl"
cmp -s "$source_root/subdir/payload.txt" "$source_only_dest/subdir/payload.txt" ||
    fail "source-only staging did not copy the resolver-owned tree"
[ -w "$source_only_dest/subdir/payload.txt" ] ||
    fail "source-only staged copy is not owner-writable"
[ -z "$(find "$source_only_dest" ! -type l -perm -022 -print -quit)" ] ||
    fail "source-only staged copy retained group/other write permissions"
[ "$(shasum -a 256 "$archive" | awk '{print $1}')" = "$source_only_archive_before" ] ||
    fail "source-only staging mutated the immutable archive"
[ "$(tree_digest "$source_root")" = "$source_only_source_before" ] ||
    fail "source-only staging mutated the sealed source tree"

assert_source_only_stage_rejected() {
    local label="$1"
    local archive_value="$2"
    local source_value="$3"
    local positional_value="$4"
    local work_value="$5"
    local out_value="$6"
    local dest_value="$7"
    local err_file="$TMP_ROOT/source-only-$label.err"
    rm -f "$fake_curl_sentinel"
    if (
        PATH="$fake_bin:$PATH"
        KANDELO_FAKE_CURL_SENTINEL="$fake_curl_sentinel"
        WASM_POSIX_RESOLUTION_POLICY=source-only-v1
        WASM_POSIX_DEP_SOURCE_ARCHIVE="$archive_value"
        WASM_POSIX_DEP_SOURCE_DIR="$source_value"
        WASM_POSIX_DEP_WORK_DIR="$work_value"
        WASM_POSIX_DEP_OUT_DIR="$out_value"
        export PATH KANDELO_FAKE_CURL_SENTINEL WASM_POSIX_RESOLUTION_POLICY
        export WASM_POSIX_DEP_SOURCE_ARCHIVE WASM_POSIX_DEP_SOURCE_DIR
        export WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR
        kandelo_package_stage_verified_source "$label" "$dest_value" \
            "$positional_value" "https://invalid.example/no-fallback.tar.gz" \
            "$archive_sha" "$work_value"
    ) 2>"$err_file"; then
        fail "source-only staging accepted $label"
    fi
    [ ! -e "$fake_curl_sentinel" ] ||
        fail "source-only $label rejection invoked curl"
    [ ! -e "$dest_value" ] && [ ! -L "$dest_value" ] ||
        fail "source-only $label rejection created its destination"
}

missing_archive_dest="$source_only_work/missing-archive"
assert_source_only_stage_rejected missing-archive "" "$source_root" \
    "$source_root" "$source_only_work" "$source_only_out" "$missing_archive_dest"
missing_source_dest="$source_only_work/missing-source"
assert_source_only_stage_rejected missing-source "$archive" "" "" \
    "$source_only_work" "$source_only_out" "$missing_source_dest"
archive_link="$TMP_ROOT/source-archive-link"
ln -s "$archive" "$archive_link"
archive_link_dest="$source_only_work/archive-link"
assert_source_only_stage_rejected archive-symlink "$archive_link" "$source_root" \
    "$source_root" "$source_only_work" "$source_only_out" "$archive_link_dest"
source_only_link_dest="$source_only_work/source-link"
assert_source_only_stage_rejected source-symlink "$archive" "$source_link" \
    "$source_link" "$source_only_work" "$source_only_out" "$source_only_link_dest"
wrong_archive_dir="$TMP_ROOT/wrong-archive-dir"
mkdir -p "$wrong_archive_dir"
wrong_archive_dest="$source_only_work/wrong-archive"
assert_source_only_stage_rejected wrong-archive-kind "$wrong_archive_dir" "$source_root" \
    "$source_root" "$source_only_work" "$source_only_out" "$wrong_archive_dest"
wrong_source_file="$TMP_ROOT/wrong-source-file"
printf 'not a directory\n' >"$wrong_source_file"
wrong_source_dest="$source_only_work/wrong-source"
assert_source_only_stage_rejected wrong-source-kind "$archive" "$wrong_source_file" \
    "$wrong_source_file" "$source_only_work" "$source_only_out" "$wrong_source_dest"
mismatch_source="$TMP_ROOT/mismatch-source"
mkdir -p "$mismatch_source"
mismatch_dest="$source_only_work/positional-mismatch"
assert_source_only_stage_rejected positional-mismatch "$archive" "$source_root" \
    "$mismatch_source" "$source_only_work" "$source_only_out" "$mismatch_dest"
source_work_overlap_dest="$source_root/overlap-destination"
assert_source_only_stage_rejected source-work-overlap "$archive" "$source_root" \
    "$source_root" "$source_root" "$source_only_out" "$source_work_overlap_dest"
source_out_overlap_dest="$source_only_work/source-out-overlap"
assert_source_only_stage_rejected source-out-overlap "$archive" "$source_root" \
    "$source_root" "$source_only_work" "$source_root" "$source_out_overlap_dest"
work_out_overlap_dest="$source_only_work/work-out-overlap"
assert_source_only_stage_rejected work-out-overlap "$archive" "$source_root" \
    "$source_root" "$source_only_work" "$source_only_work" "$work_out_overlap_dest"
outside_dest="$TMP_ROOT/source-only-outside-destination"
assert_source_only_stage_rejected destination-outside-work "$archive" "$source_root" \
    "$source_root" "$source_only_work" "$source_only_out" "$outside_dest"
work_link="$TMP_ROOT/source-only-work-link"
ln -s "$source_only_work" "$work_link"
linked_work_dest="$work_link/linked-work-destination"
assert_source_only_stage_rejected symlink-work "$archive" "$source_root" \
    "$source_root" "$work_link" "$source_only_out" "$linked_work_dest"
outside_parent="$TMP_ROOT/source-only-symlink-parent-target"
mkdir -p "$outside_parent"
ln -s "$outside_parent" "$source_only_work/linked-parent"
linked_parent_dest="$source_only_work/linked-parent/destination"
assert_source_only_stage_rejected symlink-destination-parent "$archive" "$source_root" \
    "$source_root" "$source_only_work" "$source_only_out" "$linked_parent_dest"

archive_dest="$TMP_ROOT/archive-dest"
kandelo_package_stage_verified_source fixture "$archive_dest" "" \
    "file://$archive" "$archive_sha" "$work_root"
grep -Fx "archive-selected source" "$archive_dest/archive.txt" >/dev/null ||
    fail "source URL/hash archive was not selected and extracted"

# The rootfs closure contains both gzip and xz upstreams. One shared staging
# helper must select decompression from the verified bytes, not a fake suffix.
xz_parent="$TMP_ROOT/xz-parent"
mkdir -p "$xz_parent/upstream-xz-1.0"
printf 'xz-selected source\n' >"$xz_parent/upstream-xz-1.0/archive.txt"
xz_archive="$TMP_ROOT/source.tar.xz"
tar cJf "$xz_archive" -C "$xz_parent" upstream-xz-1.0
xz_sha="$(shasum -a 256 "$xz_archive" | awk '{print $1}')"
xz_dest="$TMP_ROOT/xz-dest"
kandelo_package_stage_verified_source fixture-xz "$xz_dest" "" \
    "file://$xz_archive" "$xz_sha" "$work_root"
grep -Fx "xz-selected source" "$xz_dest/archive.txt" >/dev/null ||
    fail "verified xz source archive was not extracted"

# SQLite's reviewed amalgamation source is a ZIP archive. The shared source
# staging contract must preserve the same verified-directory shape for it as
# for the tar-based package sources.
zip_parent="$TMP_ROOT/zip-parent"
mkdir -p "$zip_parent/sqlite-amalgamation-fixture"
printf 'zip-selected source\n' \
    >"$zip_parent/sqlite-amalgamation-fixture/archive.txt"
zip_archive="$TMP_ROOT/source.zip"
(
    cd "$zip_parent"
    zip -qr "$zip_archive" sqlite-amalgamation-fixture
)
zip_sha="$(shasum -a 256 "$zip_archive" | awk '{print $1}')"
zip_dest="$TMP_ROOT/zip-dest"
kandelo_package_stage_verified_source fixture-zip "$zip_dest" "" \
    "file://$zip_archive" "$zip_sha" "$work_root"
grep -Fx "zip-selected source" "$zip_dest/archive.txt" >/dev/null ||
    fail "verified ZIP source archive was not extracted"

multi_zip_parent="$TMP_ROOT/multi-zip-parent"
mkdir -p "$multi_zip_parent/first-root" "$multi_zip_parent/second-root"
printf 'first\n' >"$multi_zip_parent/first-root/payload.txt"
printf 'second\n' >"$multi_zip_parent/second-root/payload.txt"
multi_zip_archive="$TMP_ROOT/multi-root-source.zip"
(
    cd "$multi_zip_parent"
    zip -qr "$multi_zip_archive" first-root second-root
)
multi_zip_sha="$(shasum -a 256 "$multi_zip_archive" | awk '{print $1}')"
multi_zip_dest="$TMP_ROOT/multi-zip-dest"
if kandelo_package_stage_verified_source fixture-multi-zip \
    "$multi_zip_dest" "" "file://$multi_zip_archive" "$multi_zip_sha" \
    "$work_root"; then
    fail "ZIP source archive with multiple roots was accepted"
fi
[ ! -e "$multi_zip_dest" ] ||
    fail "rejected multi-root ZIP left a staged source tree"

# A staged archive can live below an unrelated Git checkout during direct and
# package-staging builds. Patch paths must remain relative to that source root,
# including files introduced by a patch, rather than inheriting the parent
# repository's worktree context.
patch_parent="$TMP_ROOT/patch-parent"
patch_source="$patch_parent/nested/source"
patch_file="$TMP_ROOT/archive-source.patch"
mkdir -p "$patch_source"
git -C "$patch_parent" init -q
printf 'before\n' >"$patch_source/existing.txt"
printf '%s\n' \
    '--- a/existing.txt' \
    '+++ b/existing.txt' \
    '@@ -1 +1 @@' \
    '-before' \
    '+after' \
    '--- /dev/null' \
    '+++ b/added.txt' \
    '@@ -0,0 +1 @@' \
    '+added inside staged source' \
    >"$patch_file"
kandelo_package_git_apply_patch "$patch_source" "$patch_file" check
grep -Fx "before" "$patch_source/existing.txt" >/dev/null ||
    fail "git patch check mutated the staged source"
[ ! -e "$patch_source/added.txt" ] ||
    fail "git patch check created a staged source file"
kandelo_package_git_apply_patch "$patch_source" "$patch_file"
grep -Fx "after" "$patch_source/existing.txt" >/dev/null ||
    fail "git patch did not modify the staged source"
grep -Fx "added inside staged source" "$patch_source/added.txt" >/dev/null ||
    fail "git patch did not create a file in the staged source"
[ ! -e "$patch_parent/added.txt" ] ||
    fail "git patch escaped into the unrelated parent worktree"

bad_dest="$TMP_ROOT/bad-hash-dest"
err="$TMP_ROOT/bad-hash.err"
if kandelo_package_stage_verified_source fixture "$bad_dest" "" \
    "file://$archive" "0000000000000000000000000000000000000000000000000000000000000000" \
    "$work_root" >/dev/null 2>"$err"; then
    fail "source archive with the wrong sha256 was accepted"
fi
[ ! -e "$bad_dest" ] || fail "failed source verification left a staged source tree"

# Exercise the roots and source-selection helpers as one tiny build: immutable
# input is copied to work, and the sole published artifact lands under OUT.
integration_work="$TMP_ROOT/integration-work"
integration_out="$TMP_ROOT/integration-out"
integration_source="$TMP_ROOT/integration-source"
mkdir -p "$integration_source"
printf 'integration payload\n' >"$integration_source/input.txt"
chmod -R a-w "$integration_source"
integration_before="$(tree_digest "$integration_source")"
(
    WASM_POSIX_DEP_WORK_DIR="$integration_work"
    WASM_POSIX_DEP_OUT_DIR="$integration_out"
    WASM_POSIX_DEP_SOURCE_DIR="$integration_source"
    WASM_POSIX_DEP_TARGET_ARCH=wasm32
    export WASM_POSIX_DEP_WORK_DIR WASM_POSIX_DEP_OUT_DIR
    export WASM_POSIX_DEP_SOURCE_DIR WASM_POSIX_DEP_TARGET_ARCH
    kandelo_package_prepare_build_roots "$TMP_ROOT/integration-direct" wasm32
    kandelo_package_stage_verified_source integration \
        "$KANDELO_PACKAGE_WORK_DIR/source" "$WASM_POSIX_DEP_SOURCE_DIR" \
        "https://invalid.example/source-dir-must-win.tar.gz" "not-a-hash" \
        "$KANDELO_PACKAGE_WORK_DIR"
    tr '[:lower:]' '[:upper:]' \
        <"$KANDELO_PACKAGE_WORK_DIR/source/input.txt" \
        >"$KANDELO_PACKAGE_WORK_DIR/artifact.wasm"
    cp "$KANDELO_PACKAGE_WORK_DIR/artifact.wasm" \
        "$KANDELO_PACKAGE_OUT_DIR/artifact.wasm"
)
grep -Fx "INTEGRATION PAYLOAD" "$integration_out/artifact.wasm" >/dev/null ||
    fail "declared output did not land under WASM_POSIX_DEP_OUT_DIR"
[ "$(find "$integration_out" -type f | wc -l | tr -d ' ')" = 1 ] ||
    fail "caller output root contains undeclared work products"
[ "$(tree_digest "$integration_source")" = "$integration_before" ] ||
    fail "integrated build mutated its immutable caller source"

# Caller-owned output installation is a copy-only packaging operation. It must
# not require the repo's Rust/xtask toolchain, which an isolated build
# environment intentionally keeps out after the Wasm build finishes.
output_only_root="$TMP_ROOT/output-only"
output_only_wasm="$output_only_root/input/program.wasm"
output_only_data="$output_only_root/input/runtime.dat"
output_only_out="$output_only_root/out"
rustc_probe="$output_only_root/rustc-was-called"
mkdir -p "$(dirname "$output_only_wasm")" "$output_only_out"
printf 'wasm package payload\n' >"$output_only_wasm"
printf 'runtime package payload\n' >"$output_only_data"
(
    rustc() {
        printf 'unexpected rustc probe\n' >"$rustc_probe"
        return 93
    }
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
    WASM_POSIX_DEP_OUT_DIR="$output_only_out"
    WASM_POSIX_DEP_TARGET_ARCH=wasm32
    export WASM_POSIX_INSTALL_LOCAL_MIRROR
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION
    export WASM_POSIX_DEP_OUT_DIR WASM_POSIX_DEP_TARGET_ARCH
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary output-only-test "$output_only_wasm"
    install_local_runtime_file output-only-test "$output_only_data" \
        "share/runtime.dat"
)
[ ! -e "$rustc_probe" ] ||
    fail "caller-owned output installation invoked rustc"
cmp "$output_only_wasm" "$output_only_out/program.wasm" >/dev/null ||
    fail "caller-owned Wasm output bytes changed during installation"
cmp "$output_only_data" "$output_only_out/share/runtime.dat" >/dev/null ||
    fail "caller-owned runtime-file bytes changed during installation"

err="$output_only_root/unsafe-runtime-artifact.err"
if (
    WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    WASM_POSIX_DEP_OUT_DIR="$output_only_out"
    export WASM_POSIX_INSTALL_LOCAL_MIRROR WASM_POSIX_DEP_OUT_DIR
    # shellcheck source=/dev/null
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_runtime_file output-only-test "$output_only_data" "../escape.dat"
) 2>"$err"; then
    fail "caller-owned runtime installation accepted a parent path"
fi
grep -F "artifact must be a portable relative path" "$err" >/dev/null ||
    fail "unsafe caller-owned runtime artifact rejection was not explained"
[ ! -e "$output_only_root/escape.dat" ] ||
    fail "unsafe caller-owned runtime artifact escaped its output root"

bash "$REPO_ROOT/scripts/test-graphics-pkgconfig.sh"
bash "$REPO_ROOT/scripts/test-install-local-generation.sh"

# Every exact-shell registry recipe must enter through this tested root
# contract. Their real package builds remain separate bottle/dry-run evidence.
for package in bc dinit posix-utils-lite lsof nethack fbdoom modeset; do
    script="$REPO_ROOT/packages/registry/$package/build-$package.sh"
    grep -F 'scripts/package-build-roots.sh' "$script" >/dev/null ||
        fail "$package build does not source the caller-root contract"
    grep -F 'kandelo_package_prepare_build_roots' "$script" >/dev/null ||
        fail "$package build does not prepare caller-owned roots"
    grep -F 'WASM_POSIX_INSTALL_LOCAL_MIRROR=0' "$script" >/dev/null ||
        fail "$package build does not suppress checkout-local installation"
    if grep -E '^(BIN_DIR|OUT_BIN|RUNTIME_DIR|SRC_DIR|HOST_BUILD_DIR|CDOOM_SRC)="\$(SCRIPT_DIR|HERE)/' \
        "$script" >/dev/null; then
        fail "$package build still assigns mutable output below its script directory"
    fi
done
for package in posix-utils-lite lsof modeset; do
    script="$REPO_ROOT/packages/registry/$package/build-$package.sh"
    grep -F 'kandelo_package_select_source_root' "$script" >/dev/null ||
        fail "$package build does not select the caller's in-tree source root"
done
for package in bc dinit nethack fbdoom; do
    script="$REPO_ROOT/packages/registry/$package/build-$package.sh"
    grep -F 'kandelo_package_stage_verified_source' "$script" >/dev/null ||
        fail "$package build does not stage caller-verified source"
done

dinit_script="$REPO_ROOT/packages/registry/dinit/build-dinit.sh"
grep -F 'kandelo_package_prepare_private_sysroot dinit "$REPO_ROOT/sysroot" libcxx' \
    "$dinit_script" >/dev/null ||
    fail "dinit build does not use a resolver-work private libcxx sysroot"
if grep -F 'git clone' "$dinit_script" >/dev/null; then
    fail "dinit build still clones instead of consuming resolver-verified source"
fi

grep -F 'make -j1 CC=cc LD=cc -C util makedefs dgn_comp lev_comp dlb recover' \
    "$REPO_ROOT/packages/registry/nethack/build-nethack.sh" >/dev/null ||
    fail "NetHack host generators do not override ambient parallel MAKEFLAGS"

for package in lsof modeset netcat; do
    if grep -F 'scripts/run-wasm-fork-instrument.sh' \
        "$REPO_ROOT/packages/registry/$package/build-$package.sh" >/dev/null; then
        fail "$package build instruments a program that does not import fork"
    fi
done

grep -F 'WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto' \
    "$REPO_ROOT/packages/registry/nethack/build-nethack.sh" >/dev/null ||
    fail "NetHack build does not instrument its fork-capable artifact"

env -u WASM_POSIX_DEP_SOURCE_DIR \
    -u WASM_POSIX_DEP_SOURCE_ARCHIVE \
    bash "$REPO_ROOT/scripts/test-package-isolated-output-contracts.sh"
bash "$REPO_ROOT/scripts/test-curl-legacy-build-dependencies.sh"

# Ruby keeps source filenames in runtime assertions and publishes its generated
# rbconfig.rb. Its recipe must therefore map caller work paths at compile time
# while giving configure stable command names and sysroot-independent flags.
ruby_script="$REPO_ROOT/packages/registry/ruby/build-ruby.sh"
ruby_cc_wrapper="$REPO_ROOT/packages/registry/ruby/kandelo-ruby-cc"
ruby_retired_spawn_patch="$REPO_ROOT/packages/registry/ruby/patches/kandelo-posix-spawn.patch"
bash -n "$ruby_cc_wrapper" || fail "Ruby compiler prefix wrapper has invalid shell syntax"
ruby_wrapper_err="$TMP_ROOT/ruby-wrapper-missing-work-root.err"
if env -u KANDELO_RUBY_WORK_DIR bash "$ruby_cc_wrapper" --version \
    >/dev/null 2>"$ruby_wrapper_err"; then
    fail "Ruby compiler prefix wrapper accepted a missing work root"
fi
grep -F "must name the Ruby package work root" "$ruby_wrapper_err" >/dev/null ||
    fail "Ruby compiler prefix wrapper did not explain its missing work root"
ruby_fake_bin="$TMP_ROOT/ruby-fake-bin"
ruby_wrapper_args="$TMP_ROOT/ruby-wrapper-args"
mkdir -p "$ruby_fake_bin"
cat > "$ruby_fake_bin/wasm32posix-cc" <<'RUBY_FAKE_CC'
#!/usr/bin/env bash
printf '%s\n' "$@"
RUBY_FAKE_CC
chmod +x "$ruby_fake_bin/wasm32posix-cc"
KANDELO_RUBY_WORK_DIR="$TMP_ROOT/caller-ruby-work" \
    PATH="$ruby_fake_bin:$PATH" \
    bash "$ruby_cc_wrapper" -O2 conftest.c > "$ruby_wrapper_args"
for map_kind in ffile fdebug fmacro; do
    grep -Fx -- "-${map_kind}-prefix-map=$TMP_ROOT/caller-ruby-work=/usr/src/kandelo-packages/ruby" \
        "$ruby_wrapper_args" >/dev/null ||
        fail "Ruby compiler wrapper is missing its ${map_kind} caller-work prefix map"
done
grep -Fx -- "-O2" "$ruby_wrapper_args" >/dev/null ||
    fail "Ruby compiler wrapper did not preserve a compiler option"
grep -Fx "conftest.c" "$ruby_wrapper_args" >/dev/null ||
    fail "Ruby compiler wrapper did not preserve a source argument"
grep -F "cp \"\$SCRIPT_DIR/kandelo-ruby-cc\"" "$ruby_script" >/dev/null ||
    fail "Ruby build does not install its tested compiler prefix wrapper"
grep -F "CC=\"\$RUBY_CC_COMMAND\"" "$ruby_script" >/dev/null ||
    fail "Ruby configure does not use its stable compiler command"
grep -F -- "--with-baseruby=\"\$BASERUBY_COMMAND\"" "$ruby_script" >/dev/null ||
    fail "Ruby configure does not record its stable baseruby command"
grep -F "CPPFLAGS=\"-DRUBY_KANDELO_POSIX=1 -I\$ZLIB_PREFIX/include\"" \
    "$ruby_script" >/dev/null ||
    fail "Ruby configure CPPFLAGS reintroduced its private sysroot path"
grep -F "LDFLAGS=\"-L\$ZLIB_PREFIX/lib -Wl,-z,stack-size=1048576\"" \
    "$ruby_script" >/dev/null ||
    fail "Ruby configure LDFLAGS reintroduced its private sysroot path"
grep -F 'GUEST_PREFIX="${WASM_POSIX_DEP_GUEST_PREFIX-/usr}"' "$ruby_script" >/dev/null ||
    fail "Ruby build does not default its compiled runtime prefix to /usr"
grep -F -- '--prefix="$GUEST_PREFIX"' "$ruby_script" >/dev/null ||
    fail "Ruby configure does not honor the caller-selected guest prefix"
grep -F 'libdir="$GUEST_PREFIX/lib"' "$ruby_script" >/dev/null ||
    fail "Ruby static extension link does not honor the caller-selected guest prefix"
grep -F 'RUBY_INSTALL_ROOT="$INSTALL_DIR$GUEST_PREFIX"' "$ruby_script" >/dev/null ||
    fail "Ruby runtime installation does not honor the caller-selected guest prefix"

# Ruby must build its upstream fork-then-exec implementation. Kandelo's real
# vfork semantics are declared through configure's cross-cache answers, and a
# source marker prevents an old work directory containing #1166 from leaking
# that retired package-specific backend into the rebuilt artifact.
[ ! -e "$ruby_retired_spawn_patch" ] ||
    fail "Ruby still ships its retired Kandelo posix_spawn patch"
if grep -F 'patches/kandelo-posix-spawn.patch' "$ruby_script" >/dev/null; then
    fail "Ruby build still applies its retired Kandelo posix_spawn patch"
fi
grep -F 'EXPECTED_SOURCE_MARKER="$RUBY_VERSION kandelo-port-14-upstream-vfork"' \
    "$ruby_script" >/dev/null ||
    fail "Ruby source marker does not invalidate #1166 work directories"
grep -F 'ac_cv_func_vfork=yes' "$ruby_script" >/dev/null ||
    fail "Ruby configure does not declare Kandelo vfork"
grep -F 'ac_cv_func_vfork_works=yes' "$ruby_script" >/dev/null ||
    fail "Ruby configure does not declare working Kandelo vfork semantics"
grep -F 'ac_cv_func_getresuid=yes' "$ruby_script" >/dev/null ||
    fail "Ruby configure does not expose saved user IDs to its vfork guard"
grep -F 'ac_cv_func_getresgid=yes' "$ruby_script" >/dev/null ||
    fail "Ruby configure does not expose saved group IDs to its vfork guard"
grep -F 'ac_cv_func_getuidx=no' "$ruby_script" >/dev/null ||
    fail "Ruby configure still exposes the unavailable AIX getuidx fallback"
grep -F 'ac_cv_func_getgidx=no' "$ruby_script" >/dev/null ||
    fail "Ruby configure still exposes the unavailable AIX getgidx fallback"
grep -F "grep -Eq '^#define HAVE_WORKING_VFORK 1\$'" "$ruby_script" >/dev/null ||
    fail "Ruby build does not verify HAVE_WORKING_VFORK"
grep -F "grep -F 'pid = vfork();'" "$ruby_script" >/dev/null ||
    fail "Ruby build does not preserve the upstream vfork call"
if grep -F "'HAVE_VFORK', 'HAVE_TCGETATTR'" "$ruby_script" >/dev/null; then
    fail "Ruby config postprocessing still disables HAVE_VFORK"
fi

# Ruby concatenates this prefix with DESTDIR, embeds it into rbconfig, and uses
# it for its built-in load path. Reject malformed caller input before reaching
# any compiler or dependency work.
invalid_ruby_prefixes=(
    ""
    relative/not-allowed
    /opt/../escape
    /opt//ruby
    /opt/ruby/
    "/opt/ruby path"
    $'/opt/ruby\tpath'
    $'/opt/ruby\npath'
)
for invalid_prefix in "${invalid_ruby_prefixes[@]}"; do
    err="$TMP_ROOT/ruby-guest-prefix.err"
    if WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/ruby-invalid-work" \
        WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/ruby-invalid-out" \
        WASM_POSIX_DEP_GUEST_PREFIX="$invalid_prefix" \
        bash "$ruby_script" >/dev/null 2>"$err"; then
        fail "Ruby accepted invalid guest prefix '$invalid_prefix'"
    fi
    grep -F "WASM_POSIX_DEP_GUEST_PREFIX must be" "$err" >/dev/null ||
        fail "Ruby invalid guest-prefix rejection was not explained"
done

# Invalid guest paths are rejected before NetHack reaches any toolchain or
# dependency work.
nethack_work="$TMP_ROOT/nethack-invalid-work"
nethack_out="$TMP_ROOT/nethack-invalid-out"
err="$TMP_ROOT/nethack-path.err"
if WASM_POSIX_DEP_WORK_DIR="$nethack_work" \
    WASM_POSIX_DEP_OUT_DIR="$nethack_out" \
    WASM_POSIX_DEP_TARGET_ARCH=wasm32 \
    NETHACK_HACKDIR=relative/not-allowed \
    bash "$REPO_ROOT/packages/registry/nethack/build-nethack.sh" \
    >/dev/null 2>"$err"; then
    fail "NetHack accepted a relative compiled runtime path"
fi
grep -F "NETHACK_HACKDIR must be an absolute guest path" "$err" >/dev/null ||
    fail "NetHack invalid runtime-path rejection was not explained"

# Invalid architectures likewise fail before package-specific compilers run.
for package in bc posix-utils-lite lsof nethack fbdoom modeset; do
    err="$TMP_ROOT/$package-arch.err"
    if WASM_POSIX_DEP_WORK_DIR="$TMP_ROOT/$package-invalid-work" \
        WASM_POSIX_DEP_OUT_DIR="$TMP_ROOT/$package-invalid-out" \
        WASM_POSIX_DEP_TARGET_ARCH=wasm64 \
        bash "$REPO_ROOT/packages/registry/$package/build-$package.sh" \
        >/dev/null 2>"$err"; then
        fail "$package accepted an unsupported architecture"
    fi
    grep -F "built for wasm32 only, got wasm64" "$err" >/dev/null ||
        fail "$package did not explain its unsupported architecture"
done

echo "test-package-build-roots.sh: ok"
