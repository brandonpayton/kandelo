#!/bin/bash
set -euo pipefail

# Build and run libc-test tests against the kandelo.
#
# Categories: functional, regression, math, math-relaxed
#
# Usage:
#   scripts/run-libc-tests.sh                    # run all categories (functional regression math)
#   scripts/run-libc-tests.sh functional          # run one category
#   scripts/run-libc-tests.sh functional string   # run specific test(s)
#   scripts/run-libc-tests.sh --report            # run all + math-relaxed, write report to docs/libc-test-failures.md

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SYSROOT="$REPO_ROOT/sysroot"
GLUE_DIR="$REPO_ROOT/libc/glue"
LIBC_TEST="$REPO_ROOT/tests/libc/libc-test"
BUILD_DIR="$REPO_ROOT/tests/libc/libc-test/build"
RUNNER_FIXTURE_ROOT="$BUILD_DIR/runner-fixture"
KERNEL_WASM="$("$REPO_ROOT/scripts/resolve-binary.sh" kernel.wasm)"
PROGRAM_INDEX_CHECKER=""

# ── Expected failures ──────────────────────────────────────
# Tests known to fail due to wasm32 soft-float precision limits (no hardware FPU rounding control).
# All failures are 1-2 ULP rounding errors or Bessel function inaccuracy near zero crossings.

MATH_EXPECTED_FAIL=(acosh asinh erfc j0 jn jnf lgamma lgammaf lgammaf_r sinh tgamma y0 y0f ynf)
MATH_RELAXED_EXPECTED_FAIL=(tgamma j0 y0 y0f)  # Tests with inline checks that bypass checkulp

# Tests blocked by fundamental Wasm limitations (no cancellation-point asm).
FUNCTIONAL_EXPECTED_FAIL=(
    pthread_cancel              # no cancel-point asm (__syscall_cp_asm) for Wasm
)
REGRESSION_EXPECTED_FAIL=(
    malloc-brk-fail             # OOM behavior differs in Wasm linear memory
    malloc-oom                  # OOM behavior differs in Wasm linear memory
    pthread_create-oom          # not a kernel gap — see docs/compromising-xfails.md "Not compromising"
    setenv-oom                  # OOM behavior differs in Wasm linear memory
    tls_get_new-dtv             # requires dlopen TLS (dynamic TLS not supported)
)
REGRESSION_FLAKY=(
    pthread_cond-smasher        # CI timing-sensitive pthread_cond stress test; can PASS or fail on slow runners
)

# ── Helper: check if a test is in an expected-failure list ──

is_expected_fail() {
    local test_name="$1"
    shift
    local list=("$@")
    for xf in "${list[@]}"; do
        [ "$xf" = "$test_name" ] && return 0
    done
    return 1
}

find_llvm_bin() {
    if [ -n "${LLVM_BIN:-}" ] && [ -x "$LLVM_BIN/clang" ]; then
        echo "$LLVM_BIN"
        return
    fi
    if [ -n "${LLVM_PREFIX:-}" ] && [ -x "$LLVM_PREFIX/bin/clang" ]; then
        echo "$LLVM_PREFIX/bin"
        return
    fi
    if command -v clang >/dev/null 2>&1; then
        dirname "$(command -v clang)"
        return
    fi
    echo "Error: LLVM/clang not found. Run scripts/dev-shell.sh or set LLVM_BIN/LLVM_PREFIX." >&2
    exit 1
}

LLVM_BIN="$(find_llvm_bin)"
CC="$LLVM_BIN/clang"

# Common compile flags (CFLAGS_BASE excludes -I common for overlay builds)
CFLAGS_BASE=(
    --target=wasm32-unknown-unknown
    --sysroot="$SYSROOT"
    -nostdlib
    -O2
    -matomics -mbulk-memory
    -fno-trapping-math
    -mllvm -wasm-enable-sjlj
    -mllvm -wasm-use-legacy-eh=false
    -D_GNU_SOURCE
)
CFLAGS=("${CFLAGS_BASE[@]}" -I"$LIBC_TEST/src/common")

COMMON_SRCS=(
    "$LIBC_TEST/src/common/print.c"
    "$LIBC_TEST/src/common/rand.c"
    "$LIBC_TEST/src/common/path.c"
    "$LIBC_TEST/src/common/setrlim.c"
    "$LIBC_TEST/src/common/fdfill.c"
    "$LIBC_TEST/src/common/memfill.c"
    "$LIBC_TEST/src/common/vmfill.c"
)

LINK_FLAGS=(
    "$GLUE_DIR/channel_syscall.c"
    "$GLUE_DIR/compiler_rt.c"
    "$SYSROOT/lib/crt1.o"
    "$SYSROOT/lib/libc.a"
    -Wl,--no-entry
    -Wl,--export=_start
    -Wl,--import-memory
    -Wl,--shared-memory
    -Wl,--max-memory=1073741824
    -Wl,--allow-undefined
    -Wl,--table-base=3
    -Wl,--export-table
    -Wl,--export=__wasm_init_tls
    -Wl,--export=__tls_base
    -Wl,--export=__tls_size
    -Wl,--export=__tls_align
    -Wl,--export=__stack_pointer
    -Wl,--export=__wasm_thread_init
)

# Fork-instrumentation: apply wasm-fork-instrument so fork() can save/restore
# the call stack across WebAssembly instances. The tool auto-discovers fork
# paths via call-graph analysis (no onlylist). No-op on programs that don't
# transitively call kernel.kernel_fork.
FORK_INSTRUMENT="$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"

instrument_wasm() {
    local wasm="$1"
    "$FORK_INSTRUMENT" "$wasm" -o "$wasm"
}

# Timeout per test (seconds)
TEST_TIMEOUT=30

# ── Test discovery ──────────────────────────────────────────

discover_functional() {
    ls "$LIBC_TEST/src/functional/"*.c 2>/dev/null | while read -r f; do
        local name
        name=$(basename "$f" .c)
        # Skip tests that need a companion .mk (DSOs, dlopen)
        [ -f "$LIBC_TEST/src/functional/${name}.mk" ] && continue
        # Skip _dso helper files (they're not standalone tests)
        [[ "$name" == *_dso ]] && continue
        echo "$name"
    done
}

discover_regression() {
    ls "$LIBC_TEST/src/regression/"*.c 2>/dev/null | while read -r f; do
        local name
        name=$(basename "$f" .c)
        # Skip _dso helper files (they're not standalone tests)
        [[ "$name" == *_dso ]] && continue
        # raise-race forks inside a signal handler 1000× across
        # multiple threads. It now passes on dev hosts after per-thread
        # signal routing landed, but on resource-constrained Linux CI
        # runners it can still exhaust process/thread limits and kill
        # the GHA agent before the test's own timeout fires. Skip on CI
        # unless explicitly requested; local PASS or TIME is acceptable.
        # Set ALLOW_RAISE_RACE=1 to override.
        if [ "${CI:-}" = "true" ] && [ "${ALLOW_RAISE_RACE:-0}" != "1" ]; then
            [[ "$name" == "raise-race" ]] && continue
        fi
        echo "$name"
    done
}

discover_math() {
    ls "$LIBC_TEST/src/math/"*.c 2>/dev/null | while read -r f; do
        basename "$f" .c
    done
}

discover_math-relaxed() {
    discover_math
}

# ── Build helpers ───────────────────────────────────────────

build_functional() {
    local test_name="$1"
    local src="$LIBC_TEST/src/functional/${test_name}.c"
    local wasm="$BUILD_DIR/functional/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/functional"

    "$CC" "${CFLAGS[@]}" \
        "$src" "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    instrument_wasm "$wasm"
}

build_regression() {
    local test_name="$1"
    local src="$LIBC_TEST/src/regression/${test_name}.c"
    local wasm="$BUILD_DIR/regression/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/regression"

    "$CC" "${CFLAGS[@]}" \
        "$src" "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    instrument_wasm "$wasm"
}

build_math() {
    local test_name="$1"
    local src="$LIBC_TEST/src/math/${test_name}.c"
    local wasm="$BUILD_DIR/math/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/math"

    "$CC" "${CFLAGS[@]}" \
        -I"$LIBC_TEST/src/math" \
        "$src" \
        "$LIBC_TEST/src/common/mtest.c" \
        "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    instrument_wasm "$wasm"
}

build_math-relaxed() {
    local test_name="$1"
    local src="$LIBC_TEST/src/math/${test_name}.c"
    local wasm="$BUILD_DIR/math-relaxed/${test_name}.wasm"
    mkdir -p "$BUILD_DIR/math-relaxed"

    # Use CFLAGS_BASE (without -I common) so overlay's mtest.h shadows the original
    "$CC" "${CFLAGS_BASE[@]}" \
        -I"$REPO_ROOT/tests/libc/libc-test-overlay" \
        -I"$LIBC_TEST/src/common" \
        -I"$LIBC_TEST/src/math" \
        "$src" \
        "$LIBC_TEST/src/common/mtest.c" \
        "${COMMON_SRCS[@]}" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
    instrument_wasm "$wasm"
}

build_example_program() {
    local name="$1"
    local src="$REPO_ROOT/examples/${name}.c"
    local wasm="$REPO_ROOT/examples/${name}.wasm"

    [ -f "$src" ] || return 0
    if [ -f "$wasm" ] && [ "$wasm" -nt "$src" ]; then
        return 0
    fi

    "$CC" "${CFLAGS[@]}" \
        "$src" "${LINK_FLAGS[@]}" \
        -o "$wasm" 2>/tmp/libc-test-build-err.txt
}

# ── Run a single test ───────────────────────────────────────

run_test() {
    local category="$1"
    local test_name="$2"
    local wasm="$BUILD_DIR/$category/${test_name}.wasm"
    local fixture_root=""
    local fixture_cwd=""
    local kernel_path="/usr/local/bin:/usr/bin:/bin"

    if [ "$category/$test_name" = "functional/spawn" ]; then
        fixture_root="$RUNNER_FIXTURE_ROOT"
        fixture_cwd="work"
        kernel_path="/run/kandelo-run/bin:$kernel_path"
    fi

    # Determine expected-failure list for this category
    local -a xfail_list=()
    case "$category" in
        functional)    xfail_list=("${FUNCTIONAL_EXPECTED_FAIL[@]}") ;;
        regression)    xfail_list=("${REGRESSION_EXPECTED_FAIL[@]}") ;;
        math)          xfail_list=("${MATH_EXPECTED_FAIL[@]}") ;;
        math-relaxed)  xfail_list=("${MATH_RELAXED_EXPECTED_FAIL[@]}") ;;
    esac

    local is_xfail=false
    if [ ${#xfail_list[@]} -gt 0 ] && is_expected_fail "$test_name" "${xfail_list[@]}"; then
        is_xfail=true
    fi

    local is_flaky=false
    if [ "$category" = "regression" ] && [ ${#REGRESSION_FLAKY[@]} -gt 0 ] && is_expected_fail "$test_name" "${REGRESSION_FLAKY[@]}"; then
        is_flaky=true
    fi

    # Build
    if ! "build_${category}" "$test_name" 2>/dev/null; then
        local err
        err=$(head -5 /tmp/libc-test-build-err.txt 2>/dev/null || echo "(no error output)")
        echo "BUILD ${category}/${test_name}"
        echo "$err" | head -3 | sed 's/^/  /'
        RESULTS+=("BUILD ${category}/${test_name}")
        BUILD_FAIL=$((BUILD_FAIL + 1))
        return
    fi

    # Run with timeout.
    # stdin redirected to /dev/null: run-example.ts reads process.stdin
    # when not a TTY, which would drain any pipe the caller supplies.
    set +e
    output=$(cd "$REPO_ROOT" && \
        KERNEL_CWD= \
        KERNEL_PATH="$kernel_path" \
        WASM_POSIX_XTASK_BIN="$PROGRAM_INDEX_CHECKER" \
        KANDELO_RUNNER_FIXTURE_ROOT="$fixture_root" \
        KANDELO_RUNNER_FIXTURE_CWD="$fixture_cwd" \
        KANDELO_RUNNER_GUEST_PROGRAM= \
        KANDELO_RUNNER_VFS=isolated \
        timeout "$TEST_TIMEOUT" node --experimental-wasm-exnref \
            --import tsx/esm examples/run-example.ts "${wasm}" \
            </dev/null 2>&1)
    rc=$?
    set -e

    if [ $rc -eq 0 ]; then
        if $is_flaky; then
            echo "FLAKE-PASS ${category}/${test_name}"
            RESULTS+=("FLAKE-PASS ${category}/${test_name}")
            FLAKE_PASS=$((FLAKE_PASS + 1))
        elif $is_xfail; then
            echo "XPASS ${category}/${test_name} (expected fail, but passed!)"
            RESULTS+=("XPASS ${category}/${test_name}")
            XPASS=$((XPASS + 1))
        else
            echo "PASS  ${category}/${test_name}"
            RESULTS+=("PASS  ${category}/${test_name}")
            PASS=$((PASS + 1))
        fi
    elif [ $rc -eq 124 ]; then
        if $is_flaky; then
            echo "FLAKE-TIME ${category}/${test_name} (timeout ${TEST_TIMEOUT}s)"
            RESULTS+=("FLAKE-TIME ${category}/${test_name}")
            FLAKE_TIME=$((FLAKE_TIME + 1))
        elif $is_xfail; then
            echo "XFAIL ${category}/${test_name} (expected — timeout)"
            RESULTS+=("XFAIL ${category}/${test_name}")
            XFAIL=$((XFAIL + 1))
        else
            echo "TIME  ${category}/${test_name} (timeout ${TEST_TIMEOUT}s)"
            RESULTS+=("TIME  ${category}/${test_name}")
            TIMEOUT_COUNT=$((TIMEOUT_COUNT + 1))
        fi
    else
        if $is_flaky; then
            echo "FLAKE-FAIL ${category}/${test_name} (exit $rc)"
            echo "$output" | tail -10 | head -5 | sed 's/^/  /'
            RESULTS+=("FLAKE-FAIL ${category}/${test_name}")
            FLAKE_FAIL=$((FLAKE_FAIL + 1))
        elif $is_xfail; then
            echo "XFAIL ${category}/${test_name} (expected)"
            RESULTS+=("XFAIL ${category}/${test_name}")
            XFAIL=$((XFAIL + 1))
        else
            echo "FAIL  ${category}/${test_name} (exit $rc)"
            echo "$output" | tail -10 | head -5 | sed 's/^/  /'
            RESULTS+=("FAIL  ${category}/${test_name}")
            FAIL=$((FAIL + 1))
        fi
    fi
}

# ── Main ────────────────────────────────────────────────────

REPORT_MODE=false
CATEGORIES=()
SPECIFIC_TESTS=()

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --report) REPORT_MODE=true; shift ;;
        functional|regression|math|math-relaxed)
            CATEGORIES+=("$1"); shift
            # Remaining args are specific tests within that category
            while [ $# -gt 0 ] && [[ "$1" != --* ]] && [[ "$1" != functional ]] && [[ "$1" != regression ]] && [[ "$1" != math ]] && [[ "$1" != math-relaxed ]]; do
                SPECIFIC_TESTS+=("$1"); shift
            done
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# Default: all categories (without math-relaxed for plain runs)
if [ ${#CATEGORIES[@]} -eq 0 ]; then
    if $REPORT_MODE; then
        CATEGORIES=(functional regression math math-relaxed)
    else
        CATEGORIES=(functional regression math)
    fi
fi

# Verify prerequisites
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "Error: sysroot not found. Run scripts/build-musl.sh first." >&2
    exit 1
fi
if [ ! -f "$KERNEL_WASM" ]; then
    echo "Error: kernel wasm not found. Run build.sh first." >&2
    exit 1
fi

# Prepare source-projection policy once outside the per-test timeout. Every
# runner process still executes this exact checker, so package freshness stays
# authoritative without charging a cold release build to guest runtime.
RUST_HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "$RUST_HOST_TARGET" ]; then
    echo "Error: could not determine the Rust host target." >&2
    exit 1
fi
cargo build --release -p xtask --target "$RUST_HOST_TARGET" --quiet
PROGRAM_INDEX_CHECKER="$REPO_ROOT/target/$RUST_HOST_TARGET/release/xtask"
if [ ! -f "$PROGRAM_INDEX_CHECKER" ]; then
    echo "Error: prepared xtask was not found at $PROGRAM_INDEX_CHECKER" >&2
    exit 1
fi

if ! build_example_program echo; then
    err=$(head -5 /tmp/libc-test-build-err.txt 2>/dev/null || echo "(no error output)")
    echo "Error: failed to build examples/echo.wasm" >&2
    echo "$err" | head -3 | sed 's/^/  /' >&2
    exit 1
fi

# WHY: posix_spawnp() must prove a PATH candidate exists with access(X_OK)
# before asking the host to launch it. The host-only exec map is intentionally
# not visible to VFS access(), and the canonical rootfs contains deferred
# package stubs whose payloads are outside this isolated conformance run.
# Snapshot the freshly built helper into owned guest scratch so the libc test
# exercises the real POSIX PATH lookup and the normal VFS-backed spawn path.
mkdir -p "$RUNNER_FIXTURE_ROOT/bin" "$RUNNER_FIXTURE_ROOT/work"
if [ -e "$RUNNER_FIXTURE_ROOT/bin/echo" ]; then
    chmod 0755 "$RUNNER_FIXTURE_ROOT/bin/echo"
fi
cp "$REPO_ROOT/examples/echo.wasm" "$RUNNER_FIXTURE_ROOT/bin/echo"
chmod 0555 "$RUNNER_FIXTURE_ROOT/bin/echo"

PASS=0
FAIL=0
SKIP=0
BUILD_FAIL=0
TIMEOUT_COUNT=0
XFAIL=0
XPASS=0
FLAKE_PASS=0
FLAKE_FAIL=0
FLAKE_TIME=0
RESULTS=()
TOTAL=0

for category in "${CATEGORIES[@]}"; do
    echo ""
    echo "===== ${category} tests ====="
    echo ""

    if [ ${#SPECIFIC_TESTS[@]} -gt 0 ]; then
        tests=("${SPECIFIC_TESTS[@]}")
    else
        tests=()
        while IFS= read -r t; do
            tests+=("$t")
        done < <("discover_${category}")
    fi

    for test_name in "${tests[@]}"; do
        TOTAL=$((TOTAL + 1))
        run_test "$category" "$test_name"
    done
done

# ── Summary ─────────────────────────────────────────────────

echo ""
echo "===== Results ====="
echo "PASS:    $PASS"
echo "FAIL:    $FAIL"
echo "XFAIL:   $XFAIL"
echo "XPASS:   $XPASS"
echo "FLAKY:   $((FLAKE_PASS + FLAKE_FAIL + FLAKE_TIME))"
echo "BUILD:   $BUILD_FAIL"
echo "TIMEOUT: $TIMEOUT_COUNT"
echo "TOTAL:   $TOTAL"
echo ""

# Group results by status
for status in PASS XPASS FAIL XFAIL FLAKE-PASS FLAKE-FAIL FLAKE-TIME BUILD TIME; do
    count=0
    for r in "${RESULTS[@]}"; do
        [[ "$r" == "$status "* ]] && count=$((count + 1))
    done
    if [ $count -gt 0 ]; then
        echo "── ${status} ($count) ──"
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "$status "* ]] && echo "  $r"
        done
        echo ""
    fi
done

# ── Report mode: write failures to markdown ─────────────────

if $REPORT_MODE; then
    REPORT="$REPO_ROOT/docs/libc-test-failures.md"
    {
        echo "# libc-test Failure Report"
        echo ""
        echo "Generated: $(date -u '+%Y-%m-%d %H:%M UTC')"
        echo ""
        echo "| Status | Count |"
        echo "|--------|-------|"
        echo "| PASS | $PASS |"
        echo "| FAIL | $FAIL |"
        echo "| XFAIL | $XFAIL |"
        echo "| XPASS | $XPASS |"
        echo "| FLAKY | $((FLAKE_PASS + FLAKE_FAIL + FLAKE_TIME)) |"
        echo "| BUILD | $BUILD_FAIL |"
        echo "| TIMEOUT | $TIMEOUT_COUNT |"
        echo "| **TOTAL** | **$TOTAL** |"
        echo ""

        for status in FAIL BUILD TIME; do
            count=0
            for r in "${RESULTS[@]}"; do
                [[ "$r" == "$status "* ]] && count=$((count + 1))
            done
            if [ $count -gt 0 ]; then
                case "$status" in
                    FAIL) echo "## Unexpected Failures ($count)" ;;
                    BUILD) echo "## Build Failures ($count)" ;;
                    TIME) echo "## Timeouts ($count)" ;;
                esac
                echo ""
                echo "| Test | Category |"
                echo "|------|----------|"
                for r in "${RESULTS[@]}"; do
                    if [[ "$r" == "$status "* ]]; then
                        local_test="${r#* }"
                        local_cat="${local_test%%/*}"
                        local_name="${local_test#*/}"
                        echo "| \`$local_name\` | $local_cat |"
                    fi
                done
                echo ""
            fi
        done

        # FLAKY section
        flaky_count=0
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "FLAKE-"* ]] && flaky_count=$((flaky_count + 1))
        done
        if [ $flaky_count -gt 0 ]; then
            echo "## Flaky Tests ($flaky_count)"
            echo ""
            echo "These tests are timing-sensitive under CI load and are not reliable merge gates."
            echo ""
            echo "| Status | Test | Category |"
            echo "|--------|------|----------|"
            for r in "${RESULTS[@]}"; do
                if [[ "$r" == "FLAKE-"* ]]; then
                    local_status="${r%% *}"
                    local_test="${r#* }"
                    local_cat="${local_test%%/*}"
                    local_name="${local_test#*/}"
                    echo "| $local_status | \`$local_name\` | $local_cat |"
                fi
            done
            echo ""
        fi

        # XFAIL section
        xfail_count=0
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "XFAIL "* ]] && xfail_count=$((xfail_count + 1))
        done
        if [ $xfail_count -gt 0 ]; then
            echo "## Expected Failures — XFAIL ($xfail_count)"
            echo ""
            echo "These tests fail due to known Wasm limitations: soft-float precision (math),"
            echo "missing cancel-point asm, opaque stack, no dlopen, or no file-backed mmap."
            echo ""
            echo "| Test | Category |"
            echo "|------|----------|"
            for r in "${RESULTS[@]}"; do
                if [[ "$r" == "XFAIL "* ]]; then
                    local_test="${r#* }"
                    local_cat="${local_test%%/*}"
                    local_name="${local_test#*/}"
                    echo "| \`$local_name\` | $local_cat |"
                fi
            done
            echo ""
        fi

        # XPASS section
        xpass_count=0
        for r in "${RESULTS[@]}"; do
            [[ "$r" == "XPASS "* ]] && xpass_count=$((xpass_count + 1))
        done
        if [ $xpass_count -gt 0 ]; then
            echo "## Unexpected Passes — XPASS ($xpass_count)"
            echo ""
            echo "These tests were expected to fail but passed. Consider removing them from the expected-failure list."
            echo ""
            echo "| Test | Category |"
            echo "|------|----------|"
            for r in "${RESULTS[@]}"; do
                if [[ "$r" == "XPASS "* ]]; then
                    local_test="${r#* }"
                    local_cat="${local_test%%/*}"
                    local_name="${local_test#*/}"
                    echo "| \`$local_name\` | $local_cat |"
                fi
            done
            echo ""
        fi

        echo "## Passing Tests ($PASS)"
        echo ""
        echo "<details>"
        echo "<summary>Click to expand</summary>"
        echo ""
        echo "| Test | Category |"
        echo "|------|----------|"
        for r in "${RESULTS[@]}"; do
            if [[ "$r" == "PASS "* ]]; then
                local_test="${r#* }"
                local_cat="${local_test%%/*}"
                local_name="${local_test#*/}"
                echo "| \`$local_name\` | $local_cat |"
            fi
        done
        echo ""
        echo "</details>"
    } > "$REPORT"
    echo "Report written to: $REPORT"
fi

# Exit with error if any unexpected failures
if [ $FAIL -gt 0 ] || [ $XPASS -gt 0 ] || [ $BUILD_FAIL -gt 0 ]; then
    exit 1
fi
