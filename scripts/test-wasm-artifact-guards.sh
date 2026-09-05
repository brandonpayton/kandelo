#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$REPO_ROOT/scripts/wasm-artifact-guards.sh"

for tool in wat2wasm wasm-objdump wasm-opt wasm-dis; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required test tool is unavailable: $tool" >&2
        exit 1
    fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat >"$work/abi.wat" <<'WAT'
(module
  (func $internal_abi_name (export "__abi_version") (result i32)
    i32.const 18))
WAT
wat2wasm --debug-names "$work/abi.wat" -o "$work/abi.wasm"

cat >"$work/target-aware-exec.wat" <<'WAT'
(module
  (func (export "kernel_exec_target_prepare"))
  (func (export "kernel_spawn_exec_target_prepare"))
  (func (export "kernel_exec_target_size"))
  (func (export "kernel_exec_target_read"))
  (func (export "kernel_exec_target_cancel"))
  (func (export "kernel_exec_commit"))
  (func (export "kernel_publish_spawn_child"))
  (func (export "kernel_spawn_exec_commit")))
WAT
wat2wasm "$work/target-aware-exec.wat" -o "$work/target-aware-exec.wasm"

cat >"$work/hybrid-exec.wat" <<'WAT'
(module
  (func (export "kernel_exec_target_prepare"))
  (func (export "kernel_spawn_exec_target_prepare"))
  (func (export "kernel_exec_target_size"))
  (func (export "kernel_exec_target_read"))
  (func (export "kernel_exec_target_cancel"))
  (func (export "kernel_exec_commit"))
  (func (export "kernel_publish_spawn_child"))
  (func (export "kernel_spawn_exec_commit"))
  (func (export "kernel_exec_prepare"))
  (func (export "kernel_exec_setup"))
  (func (export "kernel_exec_setup_for_thread"))
  (func (export "kernel_execve"))
  (func (export "kernel_execveat")))
WAT
wat2wasm "$work/hybrid-exec.wat" -o "$work/hybrid-exec.wasm"

if ! declare -F wasm_require_target_aware_exec_authority >/dev/null; then
    echo "ERROR: target-aware exec artifact guard is unavailable" >&2
    exit 1
fi
if ! wasm_require_target_aware_exec_authority "$work/target-aware-exec.wasm"; then
    echo "ERROR: target-aware exec artifact was rejected" >&2
    exit 1
fi
if wasm_require_target_aware_exec_authority "$work/hybrid-exec.wasm"; then
    echo "ERROR: hybrid target-aware/legacy exec artifact was accepted" >&2
    exit 1
fi

real_objdump="$(command -v wasm-objdump)"
mkdir "$work/bin"
missing_structural_tool="$work/bin/missing-wasm-fork-instrument"
cat >"$work/bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-d" ] && [ "${2:-}" = "${FAIL_WASM_OBJDUMP_PATH:-}" ]; then
    exit 1
fi
exec "$REAL_WASM_OBJDUMP" "$@"
SH
chmod +x "$work/bin/wasm-objdump"

assert_extracts_abi() {
    local path="$1"
    local description="$2"
    local actual

    actual="$(wasm_extract_abi_version "$path")"
    [ "$actual" = 18 ] || {
        echo "ERROR: primary ABI extraction returned $actual for $description" >&2
        exit 1
    }
    actual="$(
        WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
            PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" \
            FAIL_WASM_OBJDUMP_PATH="$path" wasm_extract_abi_version "$path"
    )"
    [ "$actual" = 18 ] || {
        echo "ERROR: Binaryen ABI extraction returned $actual for $description" >&2
        exit 1
    }
}

assert_rejects_abi() {
    local path="$1"
    local description="$2"

    if wasm_extract_abi_version "$path" >/dev/null 2>&1; then
        echo "ERROR: primary ABI extraction accepted $description" >&2
        exit 1
    fi
    if WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
        PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" \
        FAIL_WASM_OBJDUMP_PATH="$path" \
        wasm_extract_abi_version "$path" >/dev/null 2>&1; then
        echo "ERROR: Binaryen ABI extraction accepted $description" >&2
        exit 1
    fi
}

assert_classifies_unsafe_abi() {
    local path="$1"
    local description="$2"
    local extract_status=0

    wasm_extract_abi_version "$path" >/dev/null 2>&1 || extract_status=$?
    [ "$extract_status" -gt 1 ] || {
        echo "ERROR: ABI extraction classified $description as an absent export (status $extract_status)" >&2
        exit 1
    }
    if ! wasm_has_stale_abi "$path" 18; then
        echo "ERROR: stale-ABI predicate accepted $description" >&2
        exit 1
    fi

    extract_status=0
    WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
        PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" \
        FAIL_WASM_OBJDUMP_PATH="$path" \
        wasm_extract_abi_version "$path" >/dev/null 2>&1 || extract_status=$?
    [ "$extract_status" -gt 1 ] || {
        echo "ERROR: fallback ABI extraction classified $description as absent (status $extract_status)" >&2
        exit 1
    }
    if ! WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
        PATH="$work/bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" \
        FAIL_WASM_OBJDUMP_PATH="$path" wasm_has_stale_abi "$path" 18; then
        echo "ERROR: stale-ABI predicate accepted $description after the primary decoder failed" >&2
        exit 1
    fi
}

mkdir "$work/no-objdump-bin"
cat >"$work/no-objdump-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
exit 99
SH
chmod +x "$work/no-objdump-bin/wasm-objdump"

cat >"$work/bin/structural-identity-tool" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
    --artifact-identity)
        [ "$#" -eq 2 ] || exit 64
        if [ -n "${MOCK_IDENTITY_RECORD:-}" ]; then
            printf '%s\n' "$MOCK_IDENTITY_RECORD"
            exit 0
        fi
        state="${MOCK_ABI_STATE:-present}"
        case "$state" in
            present) version="${MOCK_ABI_VERSION:-18}" ;;
            missing|invalid) version=- ;;
            *) exit 65 ;;
        esac
        printf '0\t1\t0\t%s\t%s\t%s\t0\n' \
            "$state" "$version" "${MOCK_IMPORTS_FORK:-1}"
        ;;
    --reserved-env-imports)
        [ "$#" -eq 2 ] || exit 64
        [ "${MOCK_RESERVED_IMPORT_STATUS:-0}" -eq 0 ] || \
            exit "$MOCK_RESERVED_IMPORT_STATUS"
        [ -z "${MOCK_RESERVED_IMPORTS:-}" ] || \
            printf '%s\n' "$MOCK_RESERVED_IMPORTS"
        ;;
    *) exit 64 ;;
esac
SH
chmod +x "$work/bin/structural-identity-tool"

# The structural identity decoder owns these predicates when installed. A
# deliberately unusable WABT binary proves neither helper silently falls back
# to full-module text decoding for a large ABI 43 artifact.
structural_path="$work/bin/structural-identity-tool"
cat >"$work/structural-side.wat" <<'WAT'
(module
  (import "env" "memory" (memory 1))
  (func (export "side_value") (result i32)
    i32.const 17))
WAT
wat2wasm --enable-annotations "$work/structural-side.wat" \
    -o "$work/structural-side-base.wasm"
# wasm-ld puts the dylink.0 MEM_INFO custom section immediately after the
# header. WABT appends custom annotations even with a placement hint, so build
# the exact structural role marker around its otherwise normal fixture bytes.
{
    dd if="$work/structural-side-base.wasm" bs=8 count=1 2>/dev/null
    printf '\000\017\010dylink.0\001\004\000\000\000\000'
    dd if="$work/structural-side-base.wasm" bs=8 skip=1 2>/dev/null
} >"$work/structural-side.wasm"

# ABI 43 C++ side modules contain proposal encodings that the installed WABT
# can partially print before returning nonzero. Loader role and import policy
# must use the wasmparser-backed identity as one exact result, never trust
# partial WABT stdout, and never fall back after an installed decoder fails.
side_identity=$'0\t1\t0\tmissing\t-\t0\t0\t0\t1\t1\t1\t0'
role_status=0
role="$(
    WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
        MOCK_IDENTITY_RECORD="$side_identity" \
        PATH="$work/no-objdump-bin:$PATH" \
        wasm_artifact_role "$work/structural-side.wasm"
)" || role_status=$?
[ "$role_status" -eq 0 ] && [ "$role" = side-module ] || {
    echo "ERROR: structural loader identity did not classify a modern side module" >&2
    exit 1
}
arch_status=0
arch="$(
    WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
        MOCK_IDENTITY_RECORD="$side_identity" \
        PATH="$work/no-objdump-bin:$PATH" \
        wasm_validate_side_module_imports "$work/structural-side.wasm"
)" || arch_status=$?
[ "$arch_status" -eq 0 ] && [ "$arch" = wasm32 ] || {
    echo "ERROR: structural loader identity did not validate modern side imports" >&2
    exit 1
}

role_status=0
WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
    MOCK_IDENTITY_RECORD=malformed \
    wasm_artifact_role "$work/structural-side.wasm" >/dev/null 2>&1 || \
    role_status=$?
[ "$role_status" -gt 1 ] || {
    echo "ERROR: side role fell back after structural decoder failure" >&2
    exit 1
}
arch_status=0
WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
    MOCK_IDENTITY_RECORD=malformed \
    wasm_validate_side_module_imports "$work/structural-side.wasm" \
        >/dev/null 2>&1 || arch_status=$?
[ "$arch_status" -gt 1 ] || {
    echo "ERROR: side import policy fell back after structural decoder failure" >&2
    exit 1
}

role_status=0
WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_artifact_role "$work/structural-side.wasm" >/dev/null 2>&1 || \
    role_status=$?
[ "$role_status" -gt 1 ] || {
    echo "ERROR: side role accepted when both structural and WABT decoders failed" >&2
    exit 1
}
arch_status=0
WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_validate_side_module_imports "$work/structural-side.wasm" \
        >/dev/null 2>&1 || arch_status=$?
[ "$arch_status" -gt 1 ] || {
    echo "ERROR: side import policy accepted when both decoders failed" >&2
    exit 1
}

actual="$(
    WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
        PATH="$work/no-objdump-bin:$PATH" wasm_extract_abi_version "$work/abi.wasm"
)"
[ "$actual" = 18 ] || {
    echo "ERROR: structural ABI extraction returned $actual" >&2
    exit 1
}
if ! WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
    PATH="$work/no-objdump-bin:$PATH" wasm_imports_kernel_fork "$work/abi.wasm"; then
    echo "ERROR: structural identity lost the kernel_fork import" >&2
    exit 1
fi
if WASM_POSIX_FORK_INSTRUMENT="$structural_path" MOCK_IMPORTS_FORK=0 \
    PATH="$work/no-objdump-bin:$PATH" wasm_imports_kernel_fork "$work/abi.wasm"; then
    echo "ERROR: structural identity invented a kernel_fork import" >&2
    exit 1
fi

structural_status=0
WASM_POSIX_FORK_INSTRUMENT="$structural_path" MOCK_ABI_STATE=missing \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_extract_abi_version "$work/abi.wasm" >/dev/null 2>&1 || structural_status=$?
[ "$structural_status" -eq 1 ] || {
    echo "ERROR: structural identity returned $structural_status for a missing ABI export" >&2
    exit 1
}
structural_status=0
WASM_POSIX_FORK_INSTRUMENT="$structural_path" MOCK_ABI_STATE=invalid \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_extract_abi_version "$work/abi.wasm" >/dev/null 2>&1 || structural_status=$?
[ "$structural_status" -gt 1 ] || {
    echo "ERROR: structural identity returned $structural_status for an invalid ABI export" >&2
    exit 1
}
structural_status=0
WASM_POSIX_FORK_INSTRUMENT="$structural_path" MOCK_IDENTITY_RECORD=malformed \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_extract_abi_version "$work/abi.wasm" >/dev/null 2>&1 || structural_status=$?
[ "$structural_status" -eq 2 ] || {
    echo "ERROR: malformed structural identity returned $structural_status instead of 2" >&2
    exit 1
}

assert_extracts_abi "$work/abi.wasm" "an implicit return"

cat >"$work/folded-command-wrapper-abi.wat" <<'WAT'
(module
  (func $__wasm_call_ctors)
  (func $__wasm_posix_user_abi_version.command_export
      (export "__abi_version") (result i32)
    call $__wasm_call_ctors
    i32.const 18))
WAT
wat2wasm --debug-names "$work/folded-command-wrapper-abi.wat" \
    -o "$work/folded-command-wrapper-abi.wasm"
assert_extracts_abi \
    "$work/folded-command-wrapper-abi.wasm" \
    "a constant-folded wasm-ld command wrapper"

cat >"$work/malformed-folded-leading-signature-abi.wat" <<'WAT'
(module
  (func $unexpected_result (result i32)
    i32.const 7)
  (func (export "__abi_version") (result i32)
    call $unexpected_result
    i32.const 18))
WAT
wat2wasm --no-check --debug-names "$work/malformed-folded-leading-signature-abi.wat" \
    -o "$work/malformed-folded-leading-signature-abi.wasm"
assert_rejects_abi \
    "$work/malformed-folded-leading-signature-abi.wasm" \
    "a folded wrapper whose leading callee is not () -> ()"
assert_classifies_unsafe_abi \
    "$work/malformed-folded-leading-signature-abi.wasm" \
    "a malformed folded wrapper signature"

cat >"$work/malformed-delegated-leading-signature-abi.wat" <<'WAT'
(module
  (func $unexpected_result (result i32)
    i32.const 7)
  (func $constant_abi (result i32)
    i32.const 18)
  (func (export "__abi_version") (result i32)
    call $unexpected_result
    call $constant_abi))
WAT
wat2wasm --no-check --debug-names "$work/malformed-delegated-leading-signature-abi.wat" \
    -o "$work/malformed-delegated-leading-signature-abi.wasm"
assert_rejects_abi \
    "$work/malformed-delegated-leading-signature-abi.wasm" \
    "a delegated wrapper whose leading callee is not () -> ()"
assert_classifies_unsafe_abi \
    "$work/malformed-delegated-leading-signature-abi.wasm" \
    "a malformed delegated leading signature"

cat >"$work/malformed-delegated-abi-signature.wat" <<'WAT'
(module
  (func $initializer)
  (func $wrong_result (result i64)
    i32.const 18)
  (func (export "__abi_version") (result i32)
    call $initializer
    call $wrong_result))
WAT
wat2wasm --no-check --debug-names "$work/malformed-delegated-abi-signature.wat" \
    -o "$work/malformed-delegated-abi-signature.wasm"
assert_rejects_abi \
    "$work/malformed-delegated-abi-signature.wasm" \
    "a delegated constant callee that is not () -> i32"
assert_classifies_unsafe_abi \
    "$work/malformed-delegated-abi-signature.wasm" \
    "a malformed delegated ABI signature"

cat >"$work/nested-folded-command-wrapper-abi.wat" <<'WAT'
(module
  (func $__wasm_call_ctors)
  (func $__wasm_posix_user_abi_version.folded (result i32)
    call $__wasm_call_ctors
    i32.const 18)
  (func $__wasm_posix_user_abi_version.command_export
      (export "__abi_version") (result i32)
    call $__wasm_call_ctors
    call $__wasm_posix_user_abi_version.folded))
WAT
wat2wasm --debug-names "$work/nested-folded-command-wrapper-abi.wat" \
    -o "$work/nested-folded-command-wrapper-abi.wasm"
assert_rejects_abi \
    "$work/nested-folded-command-wrapper-abi.wasm" \
    "a delegating wrapper that targets another folded wrapper"

cat >"$work/explicit-return-abi.wat" <<'WAT'
(module
  (func $internal_abi_name (export "__abi_version") (result i32)
    i32.const 18
    return))
WAT
wat2wasm --debug-names "$work/explicit-return-abi.wat" -o "$work/explicit-return-abi.wasm"
assert_extracts_abi "$work/explicit-return-abi.wasm" "an explicit return"

cat >"$work/dynamic-abi.wat" <<'WAT'
(module
  (global $abi i32 (i32.const 18))
  (func (export "__abi_version") (result i32)
    i32.const 18
    drop
    global.get $abi))
WAT
wat2wasm "$work/dynamic-abi.wat" -o "$work/dynamic-abi.wasm"
assert_rejects_abi "$work/dynamic-abi.wasm" "a nonconstant export"

cat >"$work/conditional-dynamic-abi.wat" <<'WAT'
(module
  (global $choose i32 (i32.const 0))
  (global $abi i32 (i32.const 19))
  (func (export "_start"))
  (func (export "__abi_version") (result i32)
    global.get $choose
    if
      i32.const 18
      return
    end
    global.get $abi))
WAT
wat2wasm "$work/conditional-dynamic-abi.wat" -o "$work/conditional-dynamic-abi.wasm"
assert_rejects_abi "$work/conditional-dynamic-abi.wasm" "a conditionally constant export"
assert_classifies_unsafe_abi "$work/conditional-dynamic-abi.wasm" "a conditionally computed ABI export"
if wasm_has_missing_exports "$work/conditional-dynamic-abi.wasm" __abi_version _start; then
    echo "ERROR: resolver-shaped fixture is missing its required exports" >&2
    exit 1
fi
if wasm_has_missing_fork_instrumentation "$work/conditional-dynamic-abi.wasm"; then
    echo "ERROR: resolver-shaped fixture unexpectedly requires fork instrumentation" >&2
    exit 1
fi

cat >"$work/multiple-constant-abi.wat" <<'WAT'
(module
  (func (export "__abi_version") (result i32)
    i32.const 18
    i32.const 19
    drop))
WAT
wat2wasm "$work/multiple-constant-abi.wat" -o "$work/multiple-constant-abi.wasm"
assert_rejects_abi "$work/multiple-constant-abi.wasm" "multiple constants"

cat >"$work/argument-abi.wat" <<'WAT'
(module
  (func (export "__abi_version") (param i32) (result i32)
    i32.const 18))
WAT
wat2wasm "$work/argument-abi.wat" -o "$work/argument-abi.wasm"
assert_rejects_abi "$work/argument-abi.wasm" "an argument-bearing export"
assert_classifies_unsafe_abi "$work/argument-abi.wasm" "an argument-bearing ABI export"

cat >"$work/no-abi.wat" <<'WAT'
(module
  (func (export "_start")))
WAT
wat2wasm "$work/no-abi.wat" -o "$work/no-abi.wasm"
no_abi_status=0
wasm_extract_abi_version "$work/no-abi.wasm" >/dev/null 2>&1 || no_abi_status=$?
[ "$no_abi_status" -eq 1 ] || {
    echo "ERROR: absent optional ABI export returned status $no_abi_status instead of 1" >&2
    exit 1
}
if wasm_has_stale_abi "$work/no-abi.wasm" 18; then
    echo "ERROR: stale-ABI predicate rejected a genuinely absent optional ABI export" >&2
    exit 1
fi

cat >"$work/checkpoint-only.wat" <<'WAT'
(module
  (import "kernel" "kernel_checkpoint" (func))
  (func (export "_start")))
WAT
wat2wasm "$work/checkpoint-only.wat" -o "$work/checkpoint-only.wasm"
if wasm_imports_kernel_fork "$work/checkpoint-only.wasm"; then
    echo "ERROR: a checkpoint-only program was read as importing kernel_fork" >&2
    exit 1
fi
if ! wasm_imports_kernel_checkpoint "$work/checkpoint-only.wasm"; then
    echo "ERROR: the checkpoint import predicate missed kernel_checkpoint" >&2
    exit 1
fi
if ! wasm_imports_migration_seed "$work/checkpoint-only.wasm"; then
    echo "ERROR: a checkpoint-only program carries no migration seed" >&2
    exit 1
fi
if wasm_imports_migration_seed "$work/no-abi.wasm"; then
    echo "ERROR: a program importing neither seed was read as seeded" >&2
    exit 1
fi

mkdir "$work/failing-objdump-bin"
cat >"$work/failing-objdump-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$work/failing-objdump-bin/wasm-objdump"
if ! PATH="$work/failing-objdump-bin:$PATH" \
    wasm_imports_kernel_checkpoint "$work/checkpoint-only.wasm"; then
    echo "ERROR: a failed wasm-objdump decode reported kernel_checkpoint absent" >&2
    exit 1
fi
if PATH="$work/failing-objdump-bin:$PATH" \
    wasm_imports_kernel_checkpoint "$work/no-abi.wasm"; then
    echo "ERROR: a failed wasm-objdump decode invented a kernel_checkpoint import" >&2
    exit 1
fi

cat >"$work/fork-only.wat" <<'WAT'
(module
  (import "kernel" "kernel_fork" (func (param i32 i32 i32) (result i32)))
  (func (export "_start")))
WAT
wat2wasm "$work/fork-only.wat" -o "$work/fork-only.wasm"
if wasm_imports_kernel_checkpoint "$work/fork-only.wasm"; then
    echo "ERROR: a fork-only program was read as importing kernel_checkpoint" >&2
    exit 1
fi
if ! wasm_imports_migration_seed "$work/fork-only.wasm"; then
    echo "ERROR: a fork-only program carries no migration seed" >&2
    exit 1
fi

cat >"$work/unapproved-reserved-import.wat" <<'WAT'
(module
  (import "env" "__wasm_posix_after_fork_child" (func))
  (func (export "_start")))
WAT
wat2wasm "$work/unapproved-reserved-import.wat" \
    -o "$work/unapproved-reserved-import.wasm"
reserved_import_error="$work/unapproved-reserved-import.error"
if WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
    wasm_require_approved_reserved_env_imports \
    "$work/unapproved-reserved-import.wasm" 2>"$reserved_import_error"; then
    echo "ERROR: unapproved reserved env import was accepted" >&2
    exit 1
fi
grep -Fqx \
    '       env.__wasm_posix_after_fork_child' \
    "$reserved_import_error" || {
    echo "ERROR: rejected reserved env import was not identified exactly" >&2
    cat "$reserved_import_error" >&2
    exit 1
}

cat >"$work/approved-reserved-import.wat" <<'WAT'
(module
  (import "env" "__wasm_posix_vm_interrupt_after"
    (func (param i32 i32 i32)))
  (func (export "_start")))
WAT
wat2wasm "$work/approved-reserved-import.wat" \
    -o "$work/approved-reserved-import.wasm"
WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
    wasm_require_approved_reserved_env_imports \
    "$work/approved-reserved-import.wasm"

cat >"$work/nonreserved-import.wat" <<'WAT'
(module
  (import "env" "package_owned_callback" (func))
  (func (export "_start")))
WAT
wat2wasm "$work/nonreserved-import.wat" -o "$work/nonreserved-import.wasm"
WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
    wasm_require_approved_reserved_env_imports "$work/nonreserved-import.wasm"

# Modern ABI 43 modules use the wasmparser-backed structural decoder. An
# unusable WABT fallback proves this check does not reinterpret a decoder
# limitation as either approval or rejection.
if ! WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
    MOCK_RESERVED_IMPORTS=$'func\tenv.__wasm_posix_vm_interrupt_after' \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_require_approved_reserved_env_imports "$work/approved-reserved-import.wasm"; then
    echo "ERROR: structural reserved-import guard rejected its approved host API" >&2
    exit 1
fi
structural_reserved_error="$work/structural-reserved-import.error"
if WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
    MOCK_RESERVED_IMPORTS=$'func\tenv.__wasm_posix_after_fork_child' \
    PATH="$work/no-objdump-bin:$PATH" \
    wasm_require_approved_reserved_env_imports \
        "$work/unapproved-reserved-import.wasm" 2>"$structural_reserved_error"; then
    echo "ERROR: structural reserved-import guard accepted a private libc helper" >&2
    exit 1
fi
grep -Fqx '       env.__wasm_posix_after_fork_child' \
    "$structural_reserved_error" || {
    echo "ERROR: structural reserved-import rejection lost its exact identity" >&2
    cat "$structural_reserved_error" >&2
    exit 1
}
if WASM_POSIX_FORK_INSTRUMENT="$structural_path" \
    MOCK_RESERVED_IMPORT_STATUS=1 PATH="$work/no-objdump-bin:$PATH" \
    wasm_require_approved_reserved_env_imports \
        "$work/unapproved-reserved-import.wasm" >/dev/null 2>&1; then
    echo "ERROR: reserved-import guard fell back after a structural decoder failure" >&2
    exit 1
fi

# The bottle inspector limits each validator child to 16 MiB of regular-file
# output. Large programs such as Ruby legitimately produce more structural
# decoder text than that, so ABI validation must consume it as a stream rather
# than asking Bash to materialize it as a here-string temporary file.
mkdir "$work/inflated-details-bin"
cat >"$work/inflated-details-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
if [ "${1:-}" = "-x" ]; then
    awk 'BEGIN {
        line = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        for (i = 0; i < 265000; i++) print line
    }'
fi
exec "$REAL_WASM_OBJDUMP" "$@"
SH
chmod +x "$work/inflated-details-bin/wasm-objdump"
inflated_details_bytes="$(
    PATH="$work/inflated-details-bin:$PATH" REAL_WASM_OBJDUMP="$real_objdump" \
        wasm-objdump -x "$work/abi.wasm" | wc -c | tr -d ' '
)"
[ "$inflated_details_bytes" -gt $((16 * 1024 * 1024)) ] || {
    echo "ERROR: large ABI fixture did not cross the inspector's 16 MiB boundary" >&2
    exit 1
}

python3 - \
    "$REPO_ROOT/scripts/wasm-artifact-guards.sh" \
    "$work/abi.wasm" \
    "$work/no-abi.wasm" \
    "$work/argument-abi.wasm" \
    "$work/inflated-details-bin" \
    "$real_objdump" <<'PY'
import os
import resource
import subprocess
import sys

(
    guards,
    valid_abi,
    missing_abi,
    malformed_abi,
    inflated_bin,
    real_objdump,
) = sys.argv[1:]
limit = 16 * 1024 * 1024
environment = os.environ.copy()
environment["PATH"] = f"{inflated_bin}:{environment['PATH']}"
environment["REAL_WASM_OBJDUMP"] = real_objdump
# Exercise the bounded source-only decoder under the file-size limit instead
# of letting the installed structural decoder make this fallback test vacuous.
environment["WASM_POSIX_FORK_INSTRUMENT"] = os.path.join(
    os.path.dirname(inflated_bin), "missing-wasm-fork-instrument"
)


def set_file_limit() -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))


def extract(path: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "bash",
            "-c",
            'source "$1"\nshift\nwasm_extract_abi_version "$1"',
            "_",
            guards,
            path,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        preexec_fn=set_file_limit,
    )


valid = extract(valid_abi)
if valid.returncode != 0 or valid.stdout.strip() != "18":
    raise SystemExit(
        f"large streamed ABI extraction failed ({valid.returncode}): {valid.stderr}"
    )

missing = extract(missing_abi)
if missing.returncode != 1 or missing.stdout:
    raise SystemExit(
        "large streamed ABI extraction did not report an absent export truthfully: "
        f"status={missing.returncode} stdout={missing.stdout!r} stderr={missing.stderr!r}"
    )

malformed = extract(malformed_abi)
if malformed.returncode <= 1 or malformed.stdout:
    raise SystemExit(
        "large streamed ABI extraction did not classify a malformed export as unsafe: "
        f"status={malformed.returncode} stdout={malformed.stdout!r} "
        f"stderr={malformed.stderr!r}"
    )

PY

cat >"$work/complete-fork.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\04\08\03\00\20\00\00\00\18\00\00\00\10\00\00\00")
  (@custom "kandelo.wpk_fork.capabilities" "\01\04")
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_reserve"
    (func $frame_reserve (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_commit"
    (func $frame_commit (param i32)))
  (import "env" "__wpk_fork_frame_next"
    (func $frame_next (param i32) (result i32)))
  (memory 1)
  (func (export "wpk_fork_abort_begin") (param i32))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i32))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i32))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state") (result i32)
    i32.const 0)
  (func (export "_start")
    i32.const 0
    call $kernel_fork
    drop))
WAT
wat2wasm --enable-annotations "$work/complete-fork.wat" -o "$work/complete-fork.wasm"
if ! wasm_has_complete_fork_instrumentation "$work/complete-fork.wasm"; then
    echo "ERROR: complete fork instrumentation was rejected" >&2
    exit 1
fi
if wasm_has_missing_fork_instrumentation "$work/complete-fork.wasm"; then
    echo "ERROR: complete fork instrumentation was classified as missing" >&2
    exit 1
fi
wasm_require_fork_instrumentation_if_needed "$work/complete-fork.wasm"

awk '
    { print }
    /\(func \$kernel_fork/ {
        print "  (import \"env\" \"__wasm_dlopen\""
        print "    (func (param i32 i32 i32 i32 i32) (result i32)))"
    }
' "$work/complete-fork.wat" >"$work/legacy-loader-fork.wat"
wat2wasm --enable-annotations \
    "$work/legacy-loader-fork.wat" -o "$work/legacy-loader-fork.wasm"
if wasm_has_complete_fork_instrumentation "$work/legacy-loader-fork.wasm"; then
    echo "ERROR: complete-fork predicate accepted the reentrant legacy loader import" >&2
    exit 1
fi
if ! wasm_has_missing_fork_instrumentation "$work/legacy-loader-fork.wasm"; then
    echo "ERROR: missing-fork predicate accepted the reentrant legacy loader import" >&2
    exit 1
fi
if wasm_require_fork_instrumentation_if_needed \
    "$work/legacy-loader-fork.wasm" 2>"$work/legacy-loader-fork.error"; then
    echo "ERROR: fork guard accepted the reentrant legacy loader import" >&2
    exit 1
fi
grep -F '       loader: retains reentrant env.__wasm_dlopen' \
    "$work/legacy-loader-fork.error" >/dev/null || {
    echo "ERROR: fork guard did not identify the legacy loader failure" >&2
    cat "$work/legacy-loader-fork.error" >&2
    exit 1
}

awk '
    /\(func \(export "_start"/ {
        sub(/\(func /, "(func $native_start ")
    }
    {
        line[NR] = $0
    }
    END {
        if (sub(/\)\)$/, ")", line[NR]) != 1) exit 2
        for (row = 1; row <= NR; row++) print line[row]
        print "  (start $native_start))"
    }
' "$work/complete-fork.wat" >"$work/native-start-fork.wat"
wat2wasm --enable-annotations \
    "$work/native-start-fork.wat" -o "$work/native-start-fork.wasm"
if wasm_has_complete_fork_instrumentation "$work/native-start-fork.wasm"; then
    echo "ERROR: complete-fork predicate accepted a retained native start section" >&2
    exit 1
fi
if ! wasm_has_missing_fork_instrumentation "$work/native-start-fork.wasm"; then
    echo "ERROR: missing-fork predicate accepted a retained native start section" >&2
    exit 1
fi
if wasm_require_fork_instrumentation_if_needed \
    "$work/native-start-fork.wasm" 2>"$work/native-start-fork.error"; then
    echo "ERROR: fork guard accepted a retained native start section" >&2
    exit 1
fi
grep -F '       start: retains a native Wasm start section' \
    "$work/native-start-fork.error" >/dev/null || {
    echo "ERROR: fork guard did not identify the native start failure" >&2
    cat "$work/native-start-fork.error" >&2
    exit 1
}

assert_rejects_fork_capability() {
    local wat_path="$1"
    local description="$2"
    local wasm_path="${wat_path%.wat}.wasm"
    local error_path="${wat_path%.wat}.error"

    wat2wasm --enable-annotations "$wat_path" -o "$wasm_path"
    if wasm_has_complete_fork_instrumentation "$wasm_path"; then
        echo "ERROR: complete-fork predicate accepted $description" >&2
        exit 1
    fi
    if ! wasm_has_missing_fork_instrumentation "$wasm_path"; then
        echo "ERROR: missing-fork predicate accepted $description" >&2
        exit 1
    fi
    if wasm_require_fork_instrumentation_if_needed "$wasm_path" 2>"$error_path"; then
        echo "ERROR: fork guard accepted $description" >&2
        exit 1
    fi
    grep -F '       capability:' "$error_path" >/dev/null || {
        echo "ERROR: fork guard did not identify the capability failure for $description" >&2
        cat "$error_path" >&2
        exit 1
    }
}

sed '/kandelo\.wpk_fork\.capabilities/d' \
    "$work/complete-fork.wat" >"$work/missing-fork-capability.wat"
assert_rejects_fork_capability \
    "$work/missing-fork-capability.wat" \
    "an ABI 42-style artifact with no activation-state capability"

sed 's/"\\01\\04"/"\\01\\00"/' \
    "$work/complete-fork.wat" >"$work/unsafe-fork-capability.wat"
assert_rejects_fork_capability \
    "$work/unsafe-fork-capability.wat" \
    "a capability that omits activation-state safety"

sed 's/"\\01\\04"/"\\02\\04"/' \
    "$work/complete-fork.wat" >"$work/versioned-fork-capability.wat"
assert_rejects_fork_capability \
    "$work/versioned-fork-capability.wat" \
    "an unsupported capability version"

sed 's/"\\01\\04"/"\\01\\84"/' \
    "$work/complete-fork.wat" >"$work/unknown-fork-capability.wat"
assert_rejects_fork_capability \
    "$work/unknown-fork-capability.wat" \
    "a capability with unknown flags"

sed 's/"\\01\\04"/"\\01"/' \
    "$work/complete-fork.wat" >"$work/malformed-fork-capability.wat"
assert_rejects_fork_capability \
    "$work/malformed-fork-capability.wat" \
    "a malformed capability payload"

sed '/kandelo\.wpk_fork\.capabilities/p' \
    "$work/complete-fork.wat" >"$work/duplicate-fork-capability.wat"
assert_rejects_fork_capability \
    "$work/duplicate-fork-capability.wat" \
    "duplicate capability sections"

cat >"$work/complete-fork-wasm64.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\08\08\03\00\38\00\00\00\20\00\00\00\10\00\00\00")
  (@custom "kandelo.wpk_fork.capabilities" "\01\04")
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_reserve"
    (func $frame_reserve (param i64) (result i64)))
  (import "env" "__wpk_fork_frame_commit"
    (func $frame_commit (param i64)))
  (import "env" "__wpk_fork_frame_next"
    (func $frame_next (param i64) (result i64)))
  (memory i64 1)
  (func (export "wpk_fork_abort_begin") (param i64))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i64))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i64))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state") (result i32)
    i32.const 0)
  (func (export "_start")
    i32.const 0
    call $kernel_fork
    drop))
WAT
wat2wasm --enable-annotations --enable-memory64 "$work/complete-fork-wasm64.wat" \
    -o "$work/complete-fork-wasm64.wasm"
if ! wasm_has_complete_fork_instrumentation "$work/complete-fork-wasm64.wasm"; then
    echo "ERROR: complete wasm64 fork instrumentation was rejected" >&2
    exit 1
fi
wasm_require_fork_instrumentation_if_needed "$work/complete-fork-wasm64.wasm"

cat >"$work/partial-fork.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\04\08\03\00\20\00\00\00\18\00\00\00\10\00\00\00")
  (@custom "kandelo.wpk_fork.capabilities" "\01\04")
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_reserve"
    (func $frame_reserve (param i32) (result i32)))
  (import "env" "__wpk_fork_frame_commit"
    (func $frame_commit (param i32)))
  (import "env" "__wpk_fork_frame_next"
    (func $frame_next (param i32) (result i32)))
  (memory 1)
  (func (export "wpk_fork_abort_begin") (param i32))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i32))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i32))
  (func (export "wpk_fork_rewind_end"))
  (func (export "_start")
    i32.const 0
    call $kernel_fork
    drop))
WAT
wat2wasm --enable-annotations "$work/partial-fork.wat" -o "$work/partial-fork.wasm"
partial_fork_error="$work/partial-fork.error"
if wasm_require_fork_instrumentation_if_needed \
    "$work/partial-fork.wasm" 2>"$partial_fork_error"; then
    echo "ERROR: incomplete fork instrumentation was accepted" >&2
    exit 1
fi
grep -Fqx '       missing: wpk_fork_state' "$partial_fork_error" || {
    echo "ERROR: incomplete fork instrumentation did not report its exact missing export" >&2
    cat "$partial_fork_error" >&2
    exit 1
}

# A section name is not sufficient evidence. Publication must reject a missing
# payload, malformed layout fields, or a partially installed transaction hook.
sed '/kandelo\.wpk_fork\.linked_frames/,+1d' \
    "$work/complete-fork.wat" >"$work/missing-fork-descriptor.wat"
wat2wasm --enable-annotations "$work/missing-fork-descriptor.wat" \
    -o "$work/missing-fork-descriptor.wasm"
if wasm_require_fork_instrumentation_if_needed \
    "$work/missing-fork-descriptor.wasm" >/dev/null 2>&1; then
    echo "ERROR: fork instrumentation without its descriptor was accepted" >&2
    exit 1
fi

sed 's/\\03\\00\\20/\\01\\00\\20/' \
    "$work/complete-fork.wat" >"$work/malformed-fork-descriptor.wat"
wat2wasm --enable-annotations "$work/malformed-fork-descriptor.wat" \
    -o "$work/malformed-fork-descriptor.wasm"
if wasm_require_fork_instrumentation_if_needed \
    "$work/malformed-fork-descriptor.wasm" >/dev/null 2>&1; then
    echo "ERROR: fork instrumentation with incomplete descriptor flags was accepted" >&2
    exit 1
fi

sed \
    's/\\04\\08\\03\\00\\20\\00\\00\\00\\18/\\08\\08\\03\\00\\38\\00\\00\\00\\20/' \
    "$work/complete-fork.wat" >"$work/mismatched-memory-descriptor.wat"
grep -F '\08\08\03\00\38\00\00\00\20' \
    "$work/mismatched-memory-descriptor.wat" >/dev/null || {
    echo "ERROR: failed to construct descriptor/memory drift fixture" >&2
    exit 1
}
wat2wasm --enable-annotations "$work/mismatched-memory-descriptor.wat" \
    -o "$work/mismatched-memory-descriptor.wasm"
[ "$(wasm_linked_frame_descriptor_pointer_width \
    "$work/mismatched-memory-descriptor.wasm")" = 8 ] || {
    echo "ERROR: descriptor/memory drift fixture did not contain a wasm64 descriptor" >&2
    exit 1
}
mismatched_memory_error="$work/mismatched-memory-descriptor.error"
if wasm_require_fork_instrumentation_if_needed \
    "$work/mismatched-memory-descriptor.wasm" 2>"$mismatched_memory_error"; then
    echo "ERROR: fork descriptor whose pointer width disagrees with memory was accepted" >&2
    exit 1
fi
grep -F 'descriptor declares an 8-byte pointer but module memory uses 4-byte addresses' \
    "$mismatched_memory_error" >/dev/null || {
    echo "ERROR: descriptor/memory pointer-width drift was not reported" >&2
    cat "$mismatched_memory_error" >&2
    exit 1
}

sed \
    's/(func (export "wpk_fork_abort_begin") (param i32))/(func (export "wpk_fork_abort_begin") (param i64))/' \
    "$work/complete-fork.wat" >"$work/mismatched-fork-signature.wat"
wat2wasm --enable-annotations "$work/mismatched-fork-signature.wat" \
    -o "$work/mismatched-fork-signature.wasm"
mismatched_signature_error="$work/mismatched-fork-signature.error"
if wasm_require_fork_instrumentation_if_needed \
    "$work/mismatched-fork-signature.wasm" 2>"$mismatched_signature_error"; then
    echo "ERROR: fork export with the wrong pointer signature was accepted" >&2
    exit 1
fi
grep -F 'signatures do not match module memory' "$mismatched_signature_error" >/dev/null || {
    echo "ERROR: fork signature drift was not reported" >&2
    cat "$mismatched_signature_error" >&2
    exit 1
}

sed '/__wpk_fork_frame_reserve/,+1d' \
    "$work/complete-fork.wat" >"$work/missing-frame-reserve.wat"
wat2wasm --enable-annotations "$work/missing-frame-reserve.wat" \
    -o "$work/missing-frame-reserve.wasm"
missing_import_error="$work/missing-frame-reserve.error"
if wasm_require_fork_instrumentation_if_needed \
    "$work/missing-frame-reserve.wasm" 2>"$missing_import_error"; then
    echo "ERROR: fork instrumentation with a partial frame transaction was accepted" >&2
    exit 1
fi
grep -F 'env.__wpk_fork_frame_reserve' "$missing_import_error" >/dev/null || {
    echo "ERROR: partial frame transaction did not report its missing reserve hook" >&2
    cat "$missing_import_error" >&2
    exit 1
}
if ! wasm_has_any_fork_instrumentation "$work/missing-frame-reserve.wasm"; then
    echo "ERROR: partial frame transaction was mistaken for a clean input" >&2
    exit 1
fi

cat >"$work/inert-fork.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\04\08\03\00\20\00\00\00\18\00\00\00\10\00\00\00")
  (@custom "kandelo.wpk_fork.capabilities" "\01\04")
  (memory 1)
  (func (export "wpk_fork_abort_begin") (param i32))
  (func (export "wpk_fork_abort_end"))
  (func (export "wpk_fork_unwind_begin") (param i32))
  (func (export "wpk_fork_unwind_end"))
  (func (export "wpk_fork_rewind_begin") (param i32))
  (func (export "wpk_fork_rewind_end"))
  (func (export "wpk_fork_state") (result i32)
    i32.const 0)
  (func (export "_start")))
WAT
wat2wasm --enable-annotations "$work/inert-fork.wat" -o "$work/inert-fork.wasm"
wasm_require_fork_instrumentation_if_needed "$work/inert-fork.wasm"
if wasm_require_no_fork_instrumentation "$work/inert-fork.wasm" >/dev/null 2>&1; then
    echo "ERROR: disabled fork policy accepted an inert instrumented runtime" >&2
    exit 1
fi

if wasm_require_fork_instrumentation_if_needed \
    "$work/structural-side.wasm" >/dev/null 2>&1; then
    echo "ERROR: side module without side-boundary capability was accepted" >&2
    exit 1
fi

bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
    "$work/structural-side.wasm" -o "$work/inert-side.wasm"
wasm_require_fork_instrumentation_if_needed "$work/inert-side.wasm"

cat >"$work/wasm64-linked-frame-descriptor.wat" <<'WAT'
(module
  (@custom "kandelo.wpk_fork.linked_frames"
    "KLCF\01\00\18\00\08\08\03\00\38\00\00\00\20\00\00\00\10\00\00\00"))
WAT
wat2wasm --enable-annotations "$work/wasm64-linked-frame-descriptor.wat" \
    -o "$work/wasm64-linked-frame-descriptor.wasm"
[ "$(wasm_linked_frame_descriptor_pointer_width \
    "$work/wasm64-linked-frame-descriptor.wasm")" = 8 ] || {
    echo "ERROR: valid wasm64 linked-frame descriptor was rejected" >&2
    exit 1
}

mkdir "$work/counting-bin"
cat >"$work/counting-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${1:-}" >> "$WASM_OBJDUMP_COUNT_FILE"
if [ "${FAIL_WASM_OBJDUMP_DETAILS:-0}" = 1 ] && [ "${1:-}" = "-x" ]; then
    exit 1
fi
exec "$REAL_WASM_OBJDUMP" "$@"
SH
chmod +x "$work/counting-bin/wasm-objdump"

real_inventory_tool="$REPO_ROOT/tools/bin/wasm-fork-instrument"
[ -x "$real_inventory_tool" ] || {
    echo "ERROR: shell guard test requires the built wasm-fork-instrument tool" >&2
    exit 1
}
cat >"$work/counting-bin/wasm-fork-instrument" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$WASM_FORK_INVENTORY_COUNT_FILE"
exec "$REAL_WASM_FORK_INSTRUMENT" "$@"
SH
chmod +x "$work/counting-bin/wasm-fork-instrument"

count_file="$work/wasm-objdump.count"
inventory_count_file="$work/wasm-fork-instrument.count"
: >"$count_file"
: >"$inventory_count_file"
(
    export PATH="$work/counting-bin:$PATH"
    export REAL_WASM_OBJDUMP="$real_objdump"
    export WASM_OBJDUMP_COUNT_FILE="$count_file"
    export REAL_WASM_FORK_INSTRUMENT="$real_inventory_tool"
    export WASM_FORK_INVENTORY_COUNT_FILE="$inventory_count_file"
    export WASM_POSIX_FORK_INSTRUMENT="$work/counting-bin/wasm-fork-instrument"
    export FAIL_WASM_OBJDUMP_DETAILS=1
    wasm_require_fork_instrumentation_if_needed "$work/complete-fork.wasm"
)
[ "$(grep -c '^-x$' "$count_file" || true)" = 0 ] &&
    [ "$(grep -c '^-s$' "$count_file" || true)" = 0 ] &&
    [ "$(wc -l <"$count_file" | tr -d ' ')" = 0 ] &&
    [ "$(grep -c -- '--contract-inventory' "$inventory_count_file")" = 1 ] &&
    [ "$(grep -c -- '--artifact-identity' "$inventory_count_file")" = 1 ] &&
    [ "$(grep -c -- '--fork-capability-hex' "$inventory_count_file")" = 1 ] &&
    [ "$(grep -c -- '--linked-frame-descriptor-hex' "$inventory_count_file")" = 1 ] &&
    [ "$(wc -l <"$inventory_count_file" | tr -d ' ')" = 4 ] || {
    echo "ERROR: fork validation did not use four binary contract passes" >&2
    cat "$count_file" >&2
    cat "$inventory_count_file" >&2
    exit 1
}

# The standalone guard remains usable before the Rust tool is installed. Its
# WABT compatibility path must still perform one structural pass and must not
# mistake an absent configured tool for successful validation.
: >"$count_file"
(
    export PATH="$work/counting-bin:$PATH"
    export REAL_WASM_OBJDUMP="$real_objdump"
    export WASM_OBJDUMP_COUNT_FILE="$count_file"
    export WASM_POSIX_FORK_INSTRUMENT="$work/not-installed/wasm-fork-instrument"
    wasm_require_fork_instrumentation_if_needed "$work/complete-fork.wasm"
)
[ "$(grep -c '^-x$' "$count_file")" = 1 ] &&
    [ "$(grep -c '^-s$' "$count_file")" = 2 ] &&
    [ "$(grep -c '^-h$' "$count_file")" = 1 ] &&
    [ "$(wc -l <"$count_file" | tr -d ' ')" = 4 ] || {
    echo "ERROR: fork validation did not preserve the truthful WABT fallback" >&2
    cat "$count_file" >&2
    exit 1
}

if (
    export PATH="$work/counting-bin:$PATH"
    export REAL_WASM_OBJDUMP="$real_objdump"
    export WASM_OBJDUMP_COUNT_FILE="$count_file"
    export WASM_POSIX_FORK_INSTRUMENT="$work/not-installed/wasm-fork-instrument"
    wasm_require_fork_instrumentation_if_needed \
        "$work/native-start-fork.wasm" 2>"$work/native-start-fallback.error"
); then
    echo "ERROR: WABT fork guard accepted a retained native start section" >&2
    exit 1
fi
grep -F '       start: retains a native Wasm start section' \
    "$work/native-start-fallback.error" >/dev/null || {
    echo "ERROR: WABT fork guard did not identify the native start failure" >&2
    cat "$work/native-start-fallback.error" >&2
    exit 1
}

mkdir "$work/failing-bin"
cat >"$work/failing-bin/wasm-objdump" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$work/failing-bin/wasm-objdump"

decoder_path="$work/failing-bin:$PATH"
missing_inventory_tool="$work/not-installed/wasm-fork-instrument"
if ! WASM_POSIX_FORK_INSTRUMENT="$missing_structural_tool" \
    PATH="$decoder_path" wasm_has_stale_abi "$work/abi.wasm" 18; then
    echo "ERROR: stale-ABI predicate accepted an artifact after decoder failure" >&2
    exit 1
fi
if ! PATH="$decoder_path" wasm_has_missing_exports "$work/abi.wasm" __abi_version; then
    echo "ERROR: missing-export predicate accepted an artifact after decoder failure" >&2
    exit 1
fi
if PATH="$decoder_path" wasm_require_exports "$work/abi.wasm" __abi_version >/dev/null 2>&1; then
    echo "ERROR: required-export guard accepted an artifact after decoder failure" >&2
    exit 1
fi
if ! WASM_POSIX_FORK_INSTRUMENT="$missing_inventory_tool" \
    PATH="$decoder_path" wasm_has_missing_fork_instrumentation "$work/abi.wasm"; then
    echo "ERROR: fork predicate accepted an artifact after decoder failure" >&2
    exit 1
fi
if WASM_POSIX_FORK_INSTRUMENT="$missing_inventory_tool" \
    PATH="$decoder_path" \
    wasm_require_fork_instrumentation_if_needed "$work/abi.wasm" >/dev/null 2>&1; then
    echo "ERROR: fork guard accepted an artifact after decoder failure" >&2
    exit 1
fi
if WASM_POSIX_FORK_INSTRUMENT="$missing_inventory_tool" \
    PATH="$decoder_path" \
    wasm_require_no_fork_instrumentation "$work/abi.wasm" >/dev/null 2>&1; then
    echo "ERROR: disabled-fork guard accepted an artifact after decoder failure" >&2
    exit 1
fi

cat >"$work/fake-fork-exports.wat" <<'WAT'
(module
  (import "kernel" "kernel_fork"
    (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (data (i32.const 0)
    "wpk_fork_unwind_begin wpk_fork_unwind_end wpk_fork_rewind_begin wpk_fork_rewind_end wpk_fork_state")
  (func (export "_start")
    i32.const 0
    call $kernel_fork
    drop))
WAT
wat2wasm "$work/fake-fork-exports.wat" -o "$work/fake-fork-exports.wasm"
if ! wasm_has_missing_fork_instrumentation "$work/fake-fork-exports.wasm"; then
    echo "ERROR: fork guard accepted data-segment strings as instrumentation exports" >&2
    exit 1
fi
if ! WASM_POSIX_FORK_INSTRUMENT="$missing_inventory_tool" \
    PATH=/usr/bin:/bin \
    wasm_has_missing_fork_instrumentation "$work/fake-fork-exports.wasm"; then
    echo "ERROR: decoder-free fork predicate accepted raw export-name strings" >&2
    exit 1
fi
if WASM_POSIX_FORK_INSTRUMENT="$missing_inventory_tool" \
    PATH=/usr/bin:/bin wasm_require_fork_instrumentation_if_needed \
    "$work/fake-fork-exports.wasm" >/dev/null 2>&1; then
    echo "ERROR: decoder-free fork guard accepted raw export-name strings" >&2
    exit 1
fi

echo "test-wasm-artifact-guards.sh: ok"
