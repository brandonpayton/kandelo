#!/usr/bin/env bash
#
# Shared checks for wasm artifacts that enter resolver-visible locations.
# Asyncify is retired in this repo; any wasm still exporting or naming
# `asyncify_*` is a stale fork-continuation artifact, regardless of ABI
# metadata.

wasm_is_binary() {
    local path="${1:-}"
    [ -f "$path" ] || return 1
    [ "$(od -An -tx1 -N4 "$path" 2>/dev/null | tr -d ' \n')" = "0061736d" ]
}

wasm_has_legacy_asyncify() {
    wasm_is_binary "${1:-}" || return 1
    grep -a -q 'asyncify_' "$1" 2>/dev/null
}

wasm_require_no_legacy_asyncify() {
    local path="${1:-}"
    if wasm_has_legacy_asyncify "$path"; then
        echo "ERROR: refusing legacy Asyncify wasm artifact: $path" >&2
        echo "       Rebuild it with scripts/run-wasm-fork-instrument.sh for fork-capable binaries." >&2
        return 1
    fi
}

# Reject unresolved imports in Kandelo's reserved libc/host namespace unless
# the host deliberately implements that exact API. The SDK linker permits
# undefined symbols so packages can retain real host/kernel imports. Without
# this boundary, an up-to-date glue object linked against a stale sysroot can
# turn a private libc helper into an env import; the generic host stub then
# lets the program instantiate and traps only when the helper is called.
_wasm_reserved_env_import_inventory() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local inventory_tool
    inventory_tool="$(_wasm_fork_contract_inventory_tool)" || return 127
    "$inventory_tool" --reserved-env-imports "$path" 2>/dev/null || return 2
}

wasm_require_approved_reserved_env_imports() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 0

    local inventory inventory_status=0 rejected
    inventory="$(_wasm_reserved_env_import_inventory "$path")" || inventory_status=$?
    if [ "$inventory_status" -eq 0 ]; then
        if [ -z "$inventory" ]; then
            rejected=""
        elif ! rejected="$(
            awk -F '\t' '
                NF != 2 || ($1 != "func" && $1 != "table" &&
                            $1 != "memory" && $1 != "global" && $1 != "tag") {
                    exit 2
                }
                $1 == "func" && $2 == "env.__wasm_posix_vm_interrupt_after" { next }
                { print $2 }
            ' <<<"$inventory"
        )"; then
            echo "ERROR: cannot inspect reserved Wasm imports: $path" >&2
            return 1
        fi
    elif [ "$inventory_status" -eq 127 ]; then
        if ! command -v wasm-objdump >/dev/null 2>&1; then
            echo "ERROR: cannot inspect reserved Wasm imports without a structural decoder: $path" >&2
            return 1
        fi
        if ! rejected="$(
            _wasm_stream_awk '
            / <- env\.__wasm_posix_/ {
                identity = $0
                sub(/^.* <- /, "", identity)
                # This timer callback is an intentional host API used by PHP.
                if (identity == "env.__wasm_posix_vm_interrupt_after" &&
                    $0 ~ /^ - func\[/) next
                print identity
            }
            ' wasm-objdump -x "$path"
        )"; then
            echo "ERROR: cannot inspect reserved Wasm imports: $path" >&2
            return 1
        fi
    else
        echo "ERROR: cannot inspect reserved Wasm imports: $path" >&2
        return 1
    fi
    if [ -n "$rejected" ]; then
        echo "ERROR: refusing unapproved reserved Wasm env import(s): $path" >&2
        while IFS= read -r identity; do
            [ -n "$identity" ] && echo "       $identity" >&2
        done <<<"$rejected"
        echo "       Rebuild the sysroot or explicitly add a host-owned API to the guard." >&2
        return 1
    fi
}

wasm_current_abi_version() {
    local repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);/\1/p' \
        "$repo_root/crates/shared/src/lib.rs" | head -1
}

# Run a producer into awk without inheriting either errexit or pipefail from
# the caller, then return the producer's status before the consumer's. This
# keeps large Wasm inspections streaming while ensuring a decoder failure can
# never be mistaken for a successful parse.
_wasm_stream_awk() {
    local program="${1:-}"
    shift || true
    [ -n "$program" ] && [ "$#" -gt 0 ] || return 1

    local restore_errexit=0
    local restore_pipefail=0
    case "$-" in
        *e*) restore_errexit=1; set +e ;;
    esac
    if shopt -qo pipefail; then
        restore_pipefail=1
        set +o pipefail
    fi

    "$@" 2>/dev/null | awk "$program"
    local statuses=("${PIPESTATUS[@]}")

    if [ "$restore_pipefail" -eq 1 ]; then
        set -o pipefail
    fi
    if [ "$restore_errexit" -eq 1 ]; then
        set -e
    fi

    if [ "${statuses[0]:-1}" -ne 0 ]; then
        # Status 1 is also awk's ordinary "predicate did not match" result.
        # Map a producer's status 1 to a distinct decoder-error status so
        # callers can preserve the predicate's tri-state contract.
        if [ "${statuses[0]}" -eq 1 ]; then
            return 2
        fi
        return "${statuses[0]}"
    fi
    return "${statuses[1]:-1}"
}

_wasm_objdump_abi_export_function_index() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2
    command -v wasm-objdump >/dev/null 2>&1 || return 2

    # Keep the structural decoder's potentially large output in a pipe. Ruby's
    # 20 MiB executable produces more than 16 MiB of `wasm-objdump -x` text,
    # while the only evidence needed here is one export mapping and the exact
    # signature assigned to that function.
    _wasm_stream_awk '
        /^ - type\[[0-9]+\] / {
            type_index = $0
            sub(/^ - type\[/, "", type_index)
            sub(/\].*$/, "", type_index)
            signature = $0
            sub(/^ - type\[[0-9]+\] /, "", signature)
            type_signatures[type_index] = signature
        }
        /^ - func\[[0-9]+\] sig=[0-9]+/ {
            function_index = $0
            sub(/^ - func\[/, "", function_index)
            sub(/\].*$/, "", function_index)
            signature_index = $0
            sub(/^.* sig=/, "", signature_index)
            sub(/[^0-9].*$/, "", signature_index)
            function_signatures[function_index] = signature_index
        }
        / -> "__abi_version"$/ {
            named_exports++
            if ($0 ~ /^ - func\[[0-9]+\].* -> "__abi_version"$/) {
                mapped_exports++
                target = $0
                sub(/^ - func\[/, "", target)
                sub(/\].*$/, "", target)
            }
        }
        END {
            if (named_exports == 0) exit 1
            if (named_exports != 1 || mapped_exports != 1) exit 3
            if (!(target in function_signatures)) exit 3
            signature_index = function_signatures[target]
            if (!(signature_index in type_signatures) ||
                type_signatures[signature_index] != "() -> i32") exit 3
            print target
        }
    ' wasm-objdump -x "$path"
}

_wasm_objdump_candidate_signatures_are_valid() {
    local path="${1:-}"
    local void_function_index="${2:-}"
    local i32_function_index="${3:-}"
    [[ "$void_function_index" =~ ^[0-9]*$ ]] || return 1
    [[ "$i32_function_index" =~ ^[0-9]*$ ]] || return 1
    [ -n "$void_function_index$i32_function_index" ] || return 1

    WASM_ARTIFACT_VOID_FUNC_INDEX="$void_function_index" \
    WASM_ARTIFACT_I32_FUNC_INDEX="$i32_function_index" \
    _wasm_stream_awk '
        /^ - type\[[0-9]+\] / {
            type_index = $0
            sub(/^ - type\[/, "", type_index)
            sub(/\].*$/, "", type_index)
            signature = $0
            sub(/^ - type\[[0-9]+\] /, "", signature)
            type_signatures[type_index] = signature
        }
        /^ - func\[[0-9]+\] sig=[0-9]+/ {
            function_index = $0
            sub(/^ - func\[/, "", function_index)
            sub(/\].*$/, "", function_index)
            signature_index = $0
            sub(/^.* sig=/, "", signature_index)
            sub(/[^0-9].*$/, "", signature_index)
            function_signatures[function_index] = signature_index
        }
        END {
            void_target = ENVIRON["WASM_ARTIFACT_VOID_FUNC_INDEX"]
            i32_target = ENVIRON["WASM_ARTIFACT_I32_FUNC_INDEX"]
            if (void_target != "") {
                if (!(void_target in function_signatures)) exit 1
                signature_index = function_signatures[void_target]
                if (!(signature_index in type_signatures) ||
                    type_signatures[signature_index] != "() -> nil") exit 1
            }
            if (i32_target != "") {
                if (!(i32_target in function_signatures)) exit 1
                signature_index = function_signatures[i32_target]
                if (!(signature_index in type_signatures) ||
                    type_signatures[signature_index] != "() -> i32") exit 1
            }
        }
    ' wasm-objdump -x "$path"
}

# Resolve body-shape evidence emitted by the numeric wasm-objdump parsers.
# Wrapper calls are accepted only when their targets have the exact signatures
# that make the recognized instruction sequence a valid ABI-returning thunk.
_wasm_resolve_objdump_abi_candidate() {
    local path="${1:-}"
    local candidate="${2:-}"
    local kind first second third extra version signature_status=0
    IFS=$'\t' read -r kind first second third extra <<< "$candidate"
    [ -z "$extra" ] || return 1

    case "$kind" in
        constant)
            [ -n "$first" ] && [ -z "$second" ] && [ -z "$third" ] || return 1
            version="$first"
            ;;
        folded)
            [ -n "$first" ] && [ -n "$second" ] && [ -z "$third" ] || return 1
            _wasm_objdump_candidate_signatures_are_valid \
                "$path" "$first" "" || signature_status=$?
            [ "$signature_status" -eq 0 ] || return "$signature_status"
            version="$second"
            ;;
        delegated)
            [ -n "$first" ] && [ -n "$second" ] && [ -n "$third" ] || return 1
            _wasm_objdump_candidate_signatures_are_valid \
                "$path" "$first" "$second" || signature_status=$?
            [ "$signature_status" -eq 0 ] || return "$signature_status"
            version="$third"
            ;;
        *)
            return 1
            ;;
    esac

    [[ "$version" =~ ^[0-9]+$ ]] || return 1
    printf '%s\n' "$version"
}

_wasm_extract_constant_i32_body() {
    local function_index="${1:-}"
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 1

    awk -v function_index="$function_index" '
        index($0, " func[" function_index "]") && /:$/ {
            in_function = 1
            next
        }
        in_function {
            instruction = $0
            if (!sub(/^.*\|[[:space:]]*/, "", instruction)) next
            instruction_count++
            instruction_name = instruction
            sub(/[[:space:]].*$/, "", instruction_name)

            if (instruction_count == 1) {
                first_instruction = instruction_name
                first_instruction_text = instruction
            } else if (instruction_count == 2) {
                second_instruction = instruction_name
                second_instruction_text = instruction
            } else if (instruction_count == 3) {
                third_instruction = instruction_name
            }

            if (instruction_name == "end") {
                if (instruction_count == 2 && first_instruction == "i32.const") {
                    kind = "constant"
                    value = first_instruction_text
                } else if (instruction_count == 3 && first_instruction == "i32.const" &&
                           second_instruction == "return") {
                    kind = "constant"
                    value = first_instruction_text
                } else if (instruction_count == 3 && first_instruction == "call" &&
                           first_instruction_text ~ /^call[[:space:]]+[0-9]+([[:space:]]|$)/ &&
                           second_instruction == "i32.const") {
                    kind = "folded"
                    callee = first_instruction_text
                    sub(/^call[[:space:]]+/, "", callee)
                    sub(/[[:space:]].*$/, "", callee)
                    value = second_instruction_text
                } else {
                    exit 1
                }
                sub(/^i32\.const[[:space:]]+/, "", value)
                if (value !~ /^[0-9]+$/) exit 1
                if (kind == "folded") print kind "\t" callee "\t" value
                else print kind "\t" value
                exit
            }
        }
    '
}

wasm_extract_abi_version_with_binaryen() {
    local path="${1:-}"
    local function_index="${2:-}"
    command -v wasm-opt >/dev/null 2>&1 || return 2
    [[ "$function_index" =~ ^[0-9]+$ ]] || return 3

    local extracted details extracted_function_index signature_index dump candidate abi
    extracted="$(mktemp)" || return 2
    if ! wasm-opt "$path" "--extract-function-index=$function_index" -o "$extracted" 2>/dev/null; then
        rm -f "$extracted"
        return 2
    fi
    details="$(wasm-objdump -x "$extracted" 2>/dev/null)" || {
        rm -f "$extracted"
        return 2
    }
    extracted_function_index="$(
        sed -nE 's/^ - func\[([0-9]+)\].* -> ".*"$/\1/p' <<< "$details"
    )"
    [[ "$extracted_function_index" =~ ^[0-9]+$ ]] || {
        rm -f "$extracted"
        return 3
    }
    signature_index="$(
        sed -nE "s/^ - func\\[$extracted_function_index\\] sig=([0-9]+).*/\\1/p" <<< "$details"
    )"
    [[ "$signature_index" =~ ^[0-9]+$ ]] &&
        grep -Fqx " - type[$signature_index] () -> i32" <<< "$details" || {
        rm -f "$extracted"
        return 3
    }
    dump="$(wasm-objdump -d "$extracted" 2>/dev/null)" || {
        rm -f "$extracted"
        return 2
    }
    candidate="$(_wasm_extract_constant_i32_body "$extracted_function_index" <<< "$dump")" || {
        rm -f "$extracted"
        return 3
    }
    abi="$(_wasm_resolve_objdump_abi_candidate "$extracted" "$candidate")" || {
        rm -f "$extracted"
        return 3
    }
    rm -f "$extracted"
    printf '%s\n' "$abi"
}

# Validate and print the stable structural-identity record. Return 127 only
# when the Rust decoder is unavailable so callers can distinguish a truthful
# source-only fallback from a decoder failure that must remain fail-closed.
_wasm_structural_artifact_identity() {
    local path="${1:-}"
    local identity identity_status=0
    local relocatable memory_count memory64_count abi_state abi_version
    local imports_fork has_fork_exports
    local imports_side_fork dylink_count dylink_first env_memory_count
    local unsupported_side_import_count
    local -a identity_fields

    identity="$(wasm_artifact_identity "$path")" || identity_status=$?
    [ "$identity_status" -eq 0 ] || return "$identity_status"
    IFS=$'\t' read -r -a identity_fields <<< "$identity"
    case "${#identity_fields[@]}" in
        7)
            relocatable="${identity_fields[0]}"
            memory_count="${identity_fields[1]}"
            memory64_count="${identity_fields[2]}"
            abi_state="${identity_fields[3]}"
            abi_version="${identity_fields[4]}"
            imports_fork="${identity_fields[5]}"
            has_fork_exports="${identity_fields[6]}"
            ;;
        12)
            relocatable="${identity_fields[0]}"
            memory_count="${identity_fields[1]}"
            memory64_count="${identity_fields[2]}"
            abi_state="${identity_fields[3]}"
            abi_version="${identity_fields[4]}"
            imports_fork="${identity_fields[5]}"
            imports_side_fork="${identity_fields[6]}"
            has_fork_exports="${identity_fields[7]}"
            dylink_count="${identity_fields[8]}"
            dylink_first="${identity_fields[9]}"
            env_memory_count="${identity_fields[10]}"
            unsupported_side_import_count="${identity_fields[11]}"
            [[ "$imports_side_fork" =~ ^[0-9]+$ ]] &&
                [[ "$dylink_count" =~ ^[0-9]+$ ]] &&
                [[ "$dylink_first" =~ ^[01]$ ]] &&
                [[ "$env_memory_count" =~ ^[0-9]+$ ]] &&
                [[ "$unsupported_side_import_count" =~ ^[0-9]+$ ]] || return 2
            ;;
        *) return 2 ;;
    esac

    [[ "$relocatable" =~ ^[01]$ ]] &&
        [[ "$memory_count" =~ ^[0-9]+$ ]] &&
        [[ "$memory64_count" =~ ^[0-9]+$ ]] &&
        [[ "$imports_fork" =~ ^[0-9]+$ ]] &&
        [[ "$has_fork_exports" =~ ^[01]$ ]] || return 2
    case "$abi_state" in
        present) [[ "$abi_version" =~ ^[0-9]+$ ]] || return 2 ;;
        missing|invalid) [ "$abi_version" = - ] || return 2 ;;
        *) return 2 ;;
    esac
    [ "$imports_fork" = 0 ] || imports_fork=1

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$relocatable" "$memory_count" "$memory64_count" "$abi_state" \
        "$abi_version" "$imports_fork" "$has_fork_exports"
}

# Print a constant ABI export and return 0. Return 1 only when a valid Wasm
# module genuinely has no optional ABI export; all inspection or semantic
# failures return a status greater than 1 so resolver predicates fail closed.
wasm_extract_abi_version() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local identity identity_status=0
    local relocatable memory_count memory64_count abi_state abi_version
    local imports_fork has_fork_exports
    identity="$(_wasm_structural_artifact_identity "$path")" || identity_status=$?
    if [ "$identity_status" -eq 0 ]; then
        IFS=$'\t' read -r relocatable memory_count memory64_count abi_state abi_version \
            imports_fork has_fork_exports <<< "$identity"
        case "$abi_state" in
            present)
                printf '%s\n' "$abi_version"
                return 0
                ;;
            missing) return 1 ;;
            invalid) return 3 ;;
            *) return 2 ;;
        esac
    elif [ "$identity_status" -ne 127 ]; then
        return "$identity_status"
    fi

    # WHY: source-only callers may not have the Rust decoder yet. Preserve the
    # bounded WABT/Binaryen compatibility path, but never fall back after an
    # installed structural decoder reports malformed or undecodable bytes.
    command -v wasm-objdump >/dev/null 2>&1 || return 2
    # The export name and the function's optional debug name are separate Wasm
    # concepts. SDK binaries export the internal function
    # `__wasm_posix_user_abi_version` as `__abi_version`, and stripped binaries
    # have no function names at all. Resolve the export to its numeric function
    # index first; that index is stable in `wasm-objdump` output regardless of
    # the custom name section.
    local func_index details_status=0
    func_index="$(_wasm_objdump_abi_export_function_index "$path")" || details_status=$?
    case "$details_status" in
        0) ;;
        1) return 1 ;;
        *) return "$details_status" ;;
    esac
    [[ "$func_index" =~ ^[0-9]+$ ]] || return 3

    # Accept only constants that form the direct return value. This avoids
    # mistaking an unrelated instrumentation constant in the same function for
    # the ABI marker. A final `i32.const; end` is accepted only when that `end`
    # is the last instruction in the function. wasm-ld may export a command
    # thunk that calls constructors and then delegates to the real ABI function.
    # The linker can also fold the constant implementation into that thunk,
    # producing `call; i32.const; end`. Accept that folded shape only when it is
    # the exported target; a delegating wrapper must end at a pure constant body.
    local candidate version disassembly_status=0 resolve_status=0
    candidate="$(
        WASM_ARTIFACT_ABI_FUNC_INDEX="$func_index" \
        _wasm_stream_awk '
            function function_index(token, value) {
                if (token !~ /^func\[[0-9]+\]:?$/) return ""
                value = token
                sub(/^func\[/, "", value)
                sub(/\]:?$/, "", value)
                return value
            }
            function call_index(value, target) {
                if (value !~ /^call[[:space:]]+[0-9]+([[:space:]]|$)/) return ""
                target = value
                sub(/^call[[:space:]]+/, "", target)
                sub(/[[:space:]].*$/, "", target)
                return target
            }
            function constant_value(value) {
                sub(/^i32\.const[[:space:]]+/, "", value)
                return value
            }
            function finish_function(first_callee, callee) {
                if (!in_function) return
                if (instruction_count == 2 && first_instruction == "i32.const" &&
                    second_instruction == "end") {
                    pure_constant_versions[current] = constant_value(first_instruction_text)
                } else if (instruction_count == 3 && first_instruction == "i32.const" &&
                           second_instruction == "return" && third_instruction == "end") {
                    pure_constant_versions[current] = constant_value(first_instruction_text)
                } else if (instruction_count == 3 && first_instruction == "call" &&
                           second_instruction == "i32.const" && third_instruction == "end" &&
                           call_index(first_instruction_text) != "") {
                    folded_wrapper_versions[current] = constant_value(second_instruction_text)
                    wrapper_leading_callees[current] = call_index(first_instruction_text)
                }
                if (instruction_count == 3 && first_instruction == "call" &&
                    second_instruction == "call" && third_instruction == "end") {
                    first_callee = call_index(first_instruction_text)
                    callee = call_index(second_instruction_text)
                    if (first_callee != "" && callee != "") {
                        wrapper_leading_callees[current] = first_callee
                        wrapper_callees[current] = callee
                    }
                }
                in_function = 0
            }
            BEGIN {
                target = ENVIRON["WASM_ARTIFACT_ABI_FUNC_INDEX"]
            }
            {
                index_value = function_index($2)
                if (index_value != "") {
                    finish_function()
                    current = index_value
                    in_function = 1
                    instruction_count = 0
                    first_instruction = ""
                    second_instruction = ""
                    third_instruction = ""
                    first_instruction_text = ""
                    second_instruction_text = ""
                    next
                }
                if (!in_function) next

                instruction = $0
                if (!sub(/^.*\|[[:space:]]*/, "", instruction)) next
                instruction_count++
                instruction_name = instruction
                sub(/[[:space:]].*$/, "", instruction_name)
                if (instruction_count == 1) {
                    first_instruction = instruction_name
                    first_instruction_text = instruction
                } else if (instruction_count == 2) {
                    second_instruction = instruction_name
                    second_instruction_text = instruction
                } else if (instruction_count == 3) {
                    third_instruction = instruction_name
                }
            }
            END {
                finish_function()
                if (target in pure_constant_versions) {
                    print "constant\t" pure_constant_versions[target]
                } else if (target in folded_wrapper_versions) {
                    print "folded\t" wrapper_leading_callees[target] "\t" \
                        folded_wrapper_versions[target]
                } else if (target in wrapper_callees &&
                           wrapper_callees[target] in pure_constant_versions) {
                    print "delegated\t" wrapper_leading_callees[target] "\t" \
                        wrapper_callees[target] "\t" \
                        pure_constant_versions[wrapper_callees[target]]
                } else {
                    exit 1
                }
            }
        ' wasm-objdump -d "$path"
    )" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ]; then
        version="$(_wasm_resolve_objdump_abi_candidate "$path" "$candidate")" || \
            resolve_status=$?
        if [ "$resolve_status" -eq 0 ]; then
            printf '%s\n' "$version"
            return 0
        fi
        # A complete structural decode with a wrong body or callee signature is
        # a semantic rejection. A later decoder failure may use the strict
        # Binaryen fallback instead of being mislabeled as malformed ABI data.
        [ "$resolve_status" -eq 1 ] && return 3
        disassembly_status="$resolve_status"
    fi
    # A successful full disassembly that does not have one of the exact
    # constant-return shapes is a semantic rejection, not a reason to try a
    # more permissive decoder.
    [ "$disassembly_status" -eq 1 ] && return 3

    # Large fork dispatchers can make full WABT disassembly fail before it
    # reaches the ABI export. Extract the mapped function into a small module
    # first; direct constant exports can then be checked with the same strict
    # body shape without materializing the full dispatcher.
    version=""
    if version="$(wasm_extract_abi_version_with_binaryen "$path" "$func_index")" &&
        [[ "$version" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$version"
        return 0
    fi

    # WABT 1.0.37 can read the export section of current LLVM output but may
    # fail later while disassembling modern exception-reference instructions.
    # Binaryen handles those modules. Its text format retains the export-to-
    # function mapping, so follow that mapped identifier rather than looking
    # for a function whose debug name happens to match the export. As above,
    # recognize only the exact delegated or constant-folded command thunks.
    command -v wasm-dis >/dev/null 2>&1 || return "$disassembly_status"
    disassembly_status=0
    version="$(_wasm_stream_awk '
        function trim(value) {
            sub(/^[[:space:]]+/, "", value)
            sub(/[[:space:]]+$/, "", value)
            return value
        }
        function paren_delta(value, opens, closes) {
            opens = value
            closes = value
            return gsub(/\(/, "", opens) - gsub(/\)/, "", closes)
        }
        function constant_value(value) {
            sub(/^.*\(i32\.const[[:space:]]+/, "", value)
            sub(/\).*$/, "", value)
            return value
        }
        function call_target(value, target) {
            if (value !~ /^\(call[[:space:]]+\$[^[:space:]()]+\)$/) return ""
            target = value
            sub(/^\(call[[:space:]]+/, "", target)
            sub(/\)$/, "", target)
            return target
        }
        function record_function_signature(declaration, start, function_declaration, name,
                                           prefix, suffix) {
            start = index(declaration, "(func $")
            if (start == 0) return
            function_declaration = substr(declaration, start)
            name = function_declaration
            sub(/^\(func[[:space:]]+/, "", name)
            sub(/[[:space:])].*$/, "", name)
            prefix = "(func " name
            if (index(function_declaration, prefix) != 1) return
            suffix = substr(function_declaration, length(prefix) + 1)
            if (suffix == "" || suffix == ")" || suffix == "))") {
                void_functions[name] = 1
            } else if (suffix == " (result i32)" || suffix == " (result i32))" ||
                       suffix == " (result i32)))") {
                i32_functions[name] = 1
            }
        }
        function finish_function(callee) {
            if (!in_function) return
            if (body_expression_count == 1 && candidate_count == 1) {
                pure_constant_versions[current] = candidate_version
            } else if (body_expression_count == 2 && first_call != "" &&
                       candidate_count == 1 && candidate_expression == 2 &&
                       candidate_is_direct) {
                folded_wrapper_versions[current] = candidate_version
                wrapper_leading_callees[current] = first_call
            }
            if (body_expression_count == 2 && first_call != "" && second_call != "") {
                wrapper_leading_callees[current] = first_call
                wrapper_callees[current] = second_call
            }
            in_function = 0
        }
        {
            text = trim($0)

            if (index(text, "(export \"__abi_version\" (func $") == 1) {
                target = text
                sub(/^.*\(func /, "", target)
                sub(/\)\).*$/, "", target)
                next
            }

            if (!in_function && index(text, "(import ") == 1) {
                record_function_signature(text)
            }

            if (!in_function && text ~ /^\(func[[:space:]]+\$[^[:space:]()]+/) {
                current = text
                sub(/^\(func[[:space:]]+/, "", current)
                sub(/[[:space:])].*$/, "", current)
                record_function_signature(text)
                in_function = 1
                depth = paren_delta(text)
                candidate_count = 0
                candidate_version = ""
                candidate_expression = 0
                candidate_is_direct = 0
                return_depth = 0
                body_expression_count = 0
                first_call = ""
                second_call = ""
                if (depth == 0) finish_function()
                next
            }
            if (!in_function) next

            depth_before = depth
            if (depth_before == 1 && text != ")") {
                body_expression_count++
                callee = call_target(text)
                if (body_expression_count == 1) first_call = callee
                else if (body_expression_count == 2) second_call = callee
            }
            if (depth_before == 1 && text ~ /^\(i32\.const[[:space:]]+-?[0-9]+\)$/) {
                candidate_version = constant_value(text)
                candidate_count++
                candidate_expression = body_expression_count
                candidate_is_direct = 1
            } else if (depth_before == 1 &&
                       text ~ /^\(return[[:space:]]+\(i32\.const[[:space:]]+-?[0-9]+\)\)$/) {
                candidate_version = constant_value(text)
                candidate_count++
                candidate_expression = body_expression_count
                candidate_is_direct = 0
            } else if (depth_before == 1 && text == "(return") {
                return_depth = depth_before + 1
            } else if (return_depth != 0 && depth_before == return_depth &&
                       text ~ /^\(i32\.const[[:space:]]+-?[0-9]+\)$/) {
                candidate_version = constant_value(text)
                candidate_count++
                candidate_expression = body_expression_count
                candidate_is_direct = 0
            }

            depth += paren_delta(text)
            if (return_depth != 0 && depth < return_depth) return_depth = 0
            if (depth == 0) finish_function()
        }
        END {
            finish_function()
            if (target in i32_functions && target in pure_constant_versions) {
                print pure_constant_versions[target]
            } else if (target in i32_functions && target in folded_wrapper_versions &&
                       wrapper_leading_callees[target] in void_functions) {
                print folded_wrapper_versions[target]
            } else if (target in i32_functions && target in wrapper_callees &&
                       wrapper_leading_callees[target] in void_functions &&
                       wrapper_callees[target] in i32_functions &&
                       wrapper_callees[target] in pure_constant_versions) {
                print pure_constant_versions[wrapper_callees[target]]
            } else {
                exit 1
            }
        }
    ' wasm-dis "$path" -o -)" || disassembly_status=$?
    if [ "$disassembly_status" -eq 0 ] && [[ "$version" =~ ^[0-9]+$ ]]; then
        printf '%s\n' "$version"
        return 0
    fi
    [ "$disassembly_status" -le 1 ] && return 3
    return "$disassembly_status"
}

wasm_has_stale_abi() {
    local path="${1:-}"
    local current_abi="${2:-}"
    [ -n "$current_abi" ] || return 1

    local artifact_abi extract_status=0
    artifact_abi="$(wasm_extract_abi_version "$path")" || extract_status=$?
    if [ "$extract_status" -gt 1 ]; then
        return 0
    fi
    [ -n "$artifact_abi" ] && [ "$artifact_abi" != "$current_abi" ]
}

wasm_imports_kernel_fork() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1

    local identity identity_status=0
    local relocatable memory_count memory64_count abi_state abi_version
    local imports_fork has_fork_exports
    identity="$(_wasm_structural_artifact_identity "$path")" || identity_status=$?
    if [ "$identity_status" -eq 0 ]; then
        IFS=$'\t' read -r relocatable memory_count memory64_count abi_state abi_version \
            imports_fork has_fork_exports <<< "$identity"
        [ "$imports_fork" = 1 ]
        return
    elif [ "$identity_status" -ne 127 ]; then
        return "$identity_status"
    fi

    if command -v wasm-objdump >/dev/null 2>&1; then
        _wasm_stream_awk '
            /<- kernel\.kernel_fork/ { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
    fi
    # Fallback for environments without wabt/binaryen tools. The field name is
    # stored as plain UTF-8 in the import section.
    grep -a -q 'kernel_fork' "$path" 2>/dev/null
}

wasm_imports_kernel_checkpoint() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    local scanned
    if command -v wasm-objdump >/dev/null 2>&1; then
        _wasm_stream_awk '
            /<- kernel\.kernel_checkpoint$/ { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        scanned=$?
        # wabt 1.0.37 exits nonzero on a module that uses reference types,
        # which every instrumented artifact does. A failed decode is no answer,
        # so scan the bytes rather than report the import absent.
        [ "$scanned" -le 1 ] && return "$scanned"
    fi
    # Fallback for environments without wabt/binaryen tools. The field name is
    # stored as plain UTF-8 in the import section.
    grep -a -q 'kernel_checkpoint' "$path" 2>/dev/null
}

# Return 0 when either instrumentation seed is present. A program that never
# forks still unwinds for a checkpoint, so `kernel.kernel_checkpoint` alone is
# enough to require instrumentation.
wasm_imports_migration_seed() {
    local path="${1:-}"
    wasm_imports_kernel_fork "$path" && return 0
    wasm_imports_kernel_checkpoint "$path"
}

# Return 0 only for the `env.fork` import used by a dynamically linked Wasm
# side module. Main process modules use `kernel.kernel_fork` instead.
wasm_imports_side_module_fork() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        _wasm_stream_awk '
            /<- env\.fork$/ { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
    fi
    # Import names are plain UTF-8 in the binary, but without a structural
    # decoder this fallback cannot distinguish an unrelated string. Treat a
    # match as present so callers fail safely; absence remains a negative.
    grep -a -q 'fork' "$path" 2>/dev/null
}

# Print the exact loader fields from the wasmparser-backed artifact identity.
# Return 127 only when that decoder is unavailable. An installed decoder that
# fails or emits a malformed record is authoritative failure: callers must not
# reinterpret partial output from an older text decoder as a valid module.
_wasm_structural_loader_identity() {
    local path="${1:-}"
    local identity identity_status=0
    local -a fields

    identity="$(wasm_artifact_identity "$path")" || identity_status=$?
    [ "$identity_status" -eq 0 ] || return "$identity_status"
    IFS=$'\t' read -r -a fields <<< "$identity"
    [ "${#fields[@]}" -eq 12 ] || return 2
    [[ "${fields[0]}" =~ ^[01]$ ]] &&
        [[ "${fields[1]}" =~ ^[0-9]+$ ]] &&
        [[ "${fields[2]}" =~ ^[0-9]+$ ]] &&
        [[ "${fields[5]}" =~ ^[0-9]+$ ]] &&
        [[ "${fields[6]}" =~ ^[0-9]+$ ]] &&
        [[ "${fields[7]}" =~ ^[01]$ ]] &&
        [[ "${fields[8]}" =~ ^[0-9]+$ ]] &&
        [[ "${fields[9]}" =~ ^[01]$ ]] &&
        [[ "${fields[10]}" =~ ^[0-9]+$ ]] &&
        [[ "${fields[11]}" =~ ^[0-9]+$ ]] || return 2
    case "${fields[3]}" in
        present) [[ "${fields[4]}" =~ ^[0-9]+$ ]] || return 2 ;;
        missing|invalid) [ "${fields[4]}" = - ] || return 2 ;;
        *) return 2 ;;
    esac

    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
        "${fields[1]}" "${fields[2]}" "${fields[8]}" \
        "${fields[9]}" "${fields[10]}" "${fields[11]}"
}

# Print `executable` or `side-module` for a structurally decoded Wasm module.
# A valid Kandelo side module carries exactly one `dylink.0` custom section as
# its first section, matching the runtime loader contract in host/src/dylink.ts.
# Return a status greater than 1 for a decoder failure or a misplaced/duplicate
# marker so callers cannot reinterpret malformed side-module input as a process
# executable.
wasm_artifact_role() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local identity identity_status=0
    local memory_count memory64_count dylink_count dylink_first
    local env_memory_count unsupported_side_import_count extra
    identity="$(_wasm_structural_loader_identity "$path")" || identity_status=$?
    if [ "$identity_status" -eq 0 ]; then
        IFS=$'\t' read -r memory_count memory64_count dylink_count dylink_first \
            env_memory_count unsupported_side_import_count extra <<< "$identity"
        [ -z "$extra" ] || return 2
        if [ "$dylink_count" = 0 ] && [ "$dylink_first" = 0 ]; then
            printf 'executable\n'
            return 0
        fi
        if [ "$dylink_count" = 1 ] && [ "$dylink_first" = 1 ]; then
            printf 'side-module\n'
            return 0
        fi
        return 3
    elif [ "$identity_status" -ne 127 ]; then
        return "$identity_status"
    fi

    # Source-only callers may run before the Rust decoder is installed. Keep
    # the WABT path only for that explicit unavailable status; its entire
    # command must succeed before any parsed stdout is trusted.
    command -v wasm-objdump >/dev/null 2>&1 || return 2

    _wasm_stream_awk '
        /^Sections:$/ {
            in_sections = 1
            next
        }
        in_sections && / start=0x[0-9a-fA-F]+ end=0x[0-9a-fA-F]+ / {
            sections++
            if ($0 ~ /^ *Custom .* "dylink\.0"$/) {
                dylink_sections++
                if (sections == 1) dylink_first = 1
            }
        }
        END {
            if (sections == 0) exit 3
            if (dylink_sections == 0) {
                print "executable"
                exit
            }
            if (dylink_sections != 1 || dylink_first != 1) exit 3
            print "side-module"
        }
    ' wasm-objdump -h "$path"
}

# Validate the import shape that the Kandelo dynamic linker can instantiate.
# Side modules share the process memory and may import only from the namespaces
# that host/src/dylink.ts supplies. Print the detected memory architecture.
wasm_validate_side_module_imports() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local identity identity_status=0
    local memory_count memory64_count dylink_count dylink_first
    local env_memory_count unsupported_side_import_count extra
    identity="$(_wasm_structural_loader_identity "$path")" || identity_status=$?
    if [ "$identity_status" -eq 0 ]; then
        IFS=$'\t' read -r memory_count memory64_count dylink_count dylink_first \
            env_memory_count unsupported_side_import_count extra <<< "$identity"
        [ -z "$extra" ] || return 2
        [ "$memory_count" = 1 ] &&
            { [ "$memory64_count" = 0 ] || [ "$memory64_count" = 1 ]; } &&
            [ "$env_memory_count" = 1 ] &&
            [ "$unsupported_side_import_count" = 0 ] || return 3
        if [ "$memory64_count" = 1 ]; then
            printf 'wasm64\n'
        else
            printf 'wasm32\n'
        fi
        return 0
    elif [ "$identity_status" -ne 127 ]; then
        return "$identity_status"
    fi

    command -v wasm-objdump >/dev/null 2>&1 || return 2

    _wasm_stream_awk '
        /^ - memory\[[0-9]+\] pages:/ {
            memories++
            if ($0 ~ / i64( |$)/) memory64++
            if ($0 ~ / <- env\.memory$/) env_memories++
        }
        / <- / {
            identity = $0
            sub(/^.* <- /, "", identity)
            if (identity !~ /^env\./ &&
                identity !~ /^GOT\.mem\./ &&
                identity !~ /^GOT\.func\./) {
                unsupported[identity] = 1
            }
        }
        END {
            if (memories != 1 || env_memories != 1) exit 3
            for (identity in unsupported) exit 4
            if (memory64 == 1) print "wasm64"
            else print "wasm32"
        }
    ' wasm-objdump -x "$path"
}

# Resolve the in-tree instrumenter without building it as a side effect of an
# artifact policy check. Release/package jobs install this binary alongside the
# guard; source-only environments can still use the WABT fallback below.
_wasm_fork_contract_inventory_tool() {
    local configured="${WASM_POSIX_FORK_INSTRUMENT:-}"
    if [ -n "$configured" ]; then
        if [ -x "$configured" ]; then
            printf '%s\n' "$configured"
            return 0
        fi
        if [[ "$configured" != */* ]] && command -v "$configured" >/dev/null 2>&1; then
            command -v "$configured"
            return 0
        fi
        # An explicit tool selection is an ownership boundary. Do not silently
        # substitute a different binary when that exact path is unavailable.
        return 1
    fi

    local repo_root repo_tool
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || return 1
    repo_tool="$repo_root/tools/bin/wasm-fork-instrument"
    if [ -x "$repo_tool" ]; then
        printf '%s\n' "$repo_tool"
        return 0
    fi
    command -v wasm-fork-instrument 2>/dev/null
}

wasm_artifact_identity() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local inventory_tool
    inventory_tool="$(_wasm_fork_contract_inventory_tool)" || return 127
    "$inventory_tool" --artifact-identity "$path" 2>/dev/null || return 2
}

_wasm_fork_contract_inventory_decoder_available() {
    _wasm_fork_contract_inventory_tool >/dev/null ||
        command -v wasm-objdump >/dev/null 2>&1
}

# Inspect the complete fork-instrumentation contract with one structural
# decoder pass. The wasmparser-backed tool emits only the stable TSV record, so
# large programs do not materialize tens of megabytes of `wasm-objdump -x`
# text. Keep the WABT parser as a truthful compatibility fallback when the
# instrumenter binary is not installed.
#
# Output fields are, in order:
#   relocatable, imports a main or side-module fork entry,
#   frame reserve/commit/next imports,
#   linked-frame descriptor and capability counts, abort begin/end,
#   rewind begin/end, state,
#   unwind begin/end exports, module-memory count, memory64 count,
#   signature mismatches against the module memory's pointer type, and the
#   count of reentrant legacy env.__wasm_dlopen imports, and native start
#   sections retained by the final artifact.
_wasm_fork_contract_inventory() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1

    local inventory_tool inventory_status=0
    if inventory_tool="$(_wasm_fork_contract_inventory_tool)"; then
        "$inventory_tool" --contract-inventory "$path" 2>/dev/null ||
            inventory_status=$?
        if [ "$inventory_status" -eq 1 ]; then
            # Preserve the tri-state contract: status 1 means "predicate did
            # not match", while a decoder failure must fail artifact policy.
            return 2
        fi
        return "$inventory_status"
    fi

    command -v wasm-objdump >/dev/null 2>&1 || return 2

    _wasm_stream_awk '
        function function_index(line, value) {
            value = line
            sub(/^ - func\[/, "", value)
            sub(/\].*$/, "", value)
            return value + 0
        }
        function signature_index(line, value) {
            value = line
            sub(/^.* sig=/, "", value)
            sub(/[^0-9].*$/, "", value)
            return value + 0
        }
        /name: "(linking|reloc\.)/ { relocatable = 1 }
        /^ - type\[/ {
            type_index = $0
            sub(/^ - type\[/, "", type_index)
            sub(/\].*$/, "", type_index)
            signature = $0
            sub(/^.*\] /, "", signature)
            function_types[type_index + 0] = signature
            next
        }
        /^ - func\[.* sig=[0-9]+/ {
            function_signatures[function_index($0)] = function_types[signature_index($0)]
        }
        /^ - func\[.* <- kernel\.kernel_fork$/ {
            imports_fork = 1
            kernel_fork++
            kernel_fork_signatures[kernel_fork] = function_signatures[function_index($0)]
        }
        /^ - func\[.* <- env\.fork$/ { imports_fork = 1 }
        /^ - func\[.* <- env\.__wasm_dlopen$/ { legacy_dlopen++ }
        /^ - func\[.* <- env\.__wpk_fork_frame_reserve$/ {
            frame_reserve++
            frame_reserve_signatures[frame_reserve] = function_signatures[function_index($0)]
        }
        /^ - func\[.* <- env\.__wpk_fork_frame_commit$/ {
            frame_commit++
            frame_commit_signatures[frame_commit] = function_signatures[function_index($0)]
        }
        /^ - func\[.* <- env\.__wpk_fork_frame_next$/ {
            frame_next++
            frame_next_signatures[frame_next] = function_signatures[function_index($0)]
        }
        /^ - name: "kandelo\.wpk_fork\.linked_frames"$/ { linked_descriptor++ }
        /^ - name: "kandelo\.wpk_fork\.capabilities"$/ { fork_capability++ }
        /^Start:$/ { native_start++ }
        /^ - memory\[[0-9]+\] pages:/ {
            memory_count++
            if ($0 ~ / i64( |$)/) memory64_count++
        }
        /^ - func\[.* -> "wpk_fork_abort_begin"$/ {
            abort_begin++
            abort_begin_signatures[abort_begin] = function_signatures[function_index($0)]
        }
        /^ - func\[.* -> "wpk_fork_abort_end"$/ {
            abort_end++
            abort_end_signatures[abort_end] = function_signatures[function_index($0)]
        }
        /^ - func\[.* -> "wpk_fork_rewind_begin"$/ {
            rewind_begin++
            rewind_begin_signatures[rewind_begin] = function_signatures[function_index($0)]
        }
        /^ - func\[.* -> "wpk_fork_rewind_end"$/ {
            rewind_end++
            rewind_end_signatures[rewind_end] = function_signatures[function_index($0)]
        }
        /^ - func\[.* -> "wpk_fork_state"$/ {
            state++
            state_signatures[state] = function_signatures[function_index($0)]
        }
        /^ - func\[.* -> "wpk_fork_unwind_begin"$/ {
            unwind_begin++
            unwind_begin_signatures[unwind_begin] = function_signatures[function_index($0)]
        }
        /^ - func\[.* -> "wpk_fork_unwind_end"$/ {
            unwind_end++
            unwind_end_signatures[unwind_end] = function_signatures[function_index($0)]
        }
        END {
            pointer = memory_count == 1 && memory64_count == 1 ? "i64" : "i32"
            pointer_to_pointer = "(" pointer ") -> " pointer
            pointer_to_nil = "(" pointer ") -> nil"
            nil_to_nil = "() -> nil"
            for (i = 1; i <= kernel_fork; i++)
                if (kernel_fork_signatures[i] != "(i32) -> i32") signature_mismatch++
            for (i = 1; i <= frame_reserve; i++)
                if (frame_reserve_signatures[i] != pointer_to_pointer) signature_mismatch++
            for (i = 1; i <= frame_commit; i++)
                if (frame_commit_signatures[i] != pointer_to_nil) signature_mismatch++
            for (i = 1; i <= frame_next; i++)
                if (frame_next_signatures[i] != pointer_to_pointer) signature_mismatch++
            for (i = 1; i <= abort_begin; i++)
                if (abort_begin_signatures[i] != pointer_to_nil) signature_mismatch++
            for (i = 1; i <= abort_end; i++)
                if (abort_end_signatures[i] != nil_to_nil) signature_mismatch++
            for (i = 1; i <= rewind_begin; i++)
                if (rewind_begin_signatures[i] != pointer_to_nil) signature_mismatch++
            for (i = 1; i <= rewind_end; i++)
                if (rewind_end_signatures[i] != nil_to_nil) signature_mismatch++
            for (i = 1; i <= state; i++)
                if (state_signatures[i] != "() -> i32") signature_mismatch++
            for (i = 1; i <= unwind_begin; i++)
                if (unwind_begin_signatures[i] != pointer_to_nil) signature_mismatch++
            for (i = 1; i <= unwind_end; i++)
                if (unwind_end_signatures[i] != nil_to_nil) signature_mismatch++

            printf "%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\n",
                relocatable + 0, imports_fork + 0,
                frame_reserve + 0, frame_commit + 0, frame_next + 0,
                linked_descriptor + 0, fork_capability + 0,
                abort_begin + 0, abort_end + 0,
                rewind_begin + 0, rewind_end + 0, state + 0,
                unwind_begin + 0, unwind_end + 0,
                memory_count + 0, memory64_count + 0, signature_mismatch + 0,
                legacy_dlopen + 0, native_start + 0
        }
    ' wasm-objdump -x "$path"
}

_wasm_fork_capability_hex() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local inventory_tool
    if inventory_tool="$(_wasm_fork_contract_inventory_tool)"; then
        "$inventory_tool" --fork-capability-hex "$path" 2>/dev/null
        return
    fi

    command -v wasm-objdump >/dev/null 2>&1 || return 2

    _wasm_stream_awk '
        /^Contents of section Custom:$/ {
            sections++
            next
        }
        sections > 0 && /^[0-9a-fA-F]+:/ {
            line = $0
            sub(/^[^:]*:[[:space:]]*/, "", line)
            sub(/[[:space:]][[:space:]].*$/, "", line)
            gsub(/[[:space:]]/, "", line)
            if (line !~ /^[0-9a-fA-F]+$/) exit 3
            hex = hex tolower(line)
        }
        END {
            if (sections != 1 || hex == "") exit 1
            print hex
        }
    ' wasm-objdump -s -j kandelo.wpk_fork.capabilities "$path"
}

_wasm_has_fork_capability_flag() {
    local path="${1:-}"
    local required_flag="${2:-}"
    [[ "$required_flag" =~ ^[0-9]+$ ]] || return 2
    local section_hex capability_hex flags_hex flags
    section_hex="$(_wasm_fork_capability_hex "$path")" || return $?

    # One-byte name length (29), UTF-8 section name, then [version, flags].
    local name_prefix="1d6b616e64656c6f2e77706b5f666f726b2e6361706162696c6974696573"
    case "$section_hex" in
        "$name_prefix"*) capability_hex="${section_hex#"$name_prefix"}" ;;
        *) return 3 ;;
    esac
    [ "${#capability_hex}" -eq 4 ] || return 3
    [ "${capability_hex:0:2}" = "01" ] || return 3
    flags_hex="${capability_hex:2:2}"
    flags=$((16#$flags_hex))
    [ $((flags & ~7)) -eq 0 ] || return 3
    [ $((flags & required_flag)) -eq "$required_flag" ]
}

wasm_has_activation_state_safe_capability() {
    _wasm_has_fork_capability_flag "${1:-}" 4
}

wasm_has_side_entry_capability() {
    _wasm_has_fork_capability_flag "${1:-}" 1
}

_wasm_linked_frame_descriptor_hex() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 2

    local inventory_tool
    if inventory_tool="$(_wasm_fork_contract_inventory_tool)"; then
        "$inventory_tool" --linked-frame-descriptor-hex "$path" 2>/dev/null
        return
    fi

    command -v wasm-objdump >/dev/null 2>&1 || return 2

    # `wasm-objdump -x` reports a custom section's name but not its payload.
    # Read only this 24-byte section in a second targeted pass instead of
    # materializing another full detail dump for large programs.
    _wasm_stream_awk '
        /^Contents of section Custom:$/ {
            sections++
            next
        }
        sections > 0 && /^[0-9a-fA-F]+:/ {
            line = $0
            sub(/^[^:]*:[[:space:]]*/, "", line)
            sub(/[[:space:]][[:space:]].*$/, "", line)
            gsub(/[[:space:]]/, "", line)
            if (line !~ /^[0-9a-fA-F]+$/) exit 3
            hex = hex tolower(line)
        }
        END {
            if (sections != 1 || hex == "") exit 1
            print hex
        }
    ' wasm-objdump -s -j kandelo.wpk_fork.linked_frames "$path"
}

# Print 4 or 8 for one strict version-1 descriptor. Any malformed field is a
# failure: a section name alone is not proof that host and artifact agree on
# transactional node layout.
wasm_linked_frame_descriptor_pointer_width() {
    local path="${1:-}"
    local section_hex descriptor_hex
    section_hex="$(_wasm_linked_frame_descriptor_hex "$path")" || return $?

    # The raw custom-section payload begins with the one-byte length and
    # 30-byte UTF-8 section name before the descriptor itself.
    local name_prefix="1e6b616e64656c6f2e77706b5f666f726b2e6c696e6b65645f6672616d6573"
    case "$section_hex" in
        "$name_prefix"*) descriptor_hex="${section_hex#"$name_prefix"}" ;;
        *) return 3 ;;
    esac
    [ "${#descriptor_hex}" -eq 48 ] || return 3
    [ "${descriptor_hex:0:8}" = "4b4c4346" ] || return 3
    [ "${descriptor_hex:8:4}" = "0100" ] || return 3
    [ "${descriptor_hex:12:4}" = "1800" ] || return 3
    [ "${descriptor_hex:18:2}" = "08" ] || return 3
    [ "${descriptor_hex:20:4}" = "0300" ] || return 3

    case "${descriptor_hex:16:2}" in
        04)
            [ "${descriptor_hex:24:8}" = "20000000" ] || return 3
            [ "${descriptor_hex:32:8}" = "18000000" ] || return 3
            printf '4\n'
            ;;
        08)
            [ "${descriptor_hex:24:8}" = "38000000" ] || return 3
            [ "${descriptor_hex:32:8}" = "20000000" ] || return 3
            printf '8\n'
            ;;
        *)
            return 3
            ;;
    esac
}

wasm_has_wpk_fork_export() {
    local path="${1:-}"
    local name="${2:-}"
    [ -n "$name" ] || return 1
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        WASM_ARTIFACT_EXPORT_NAME="$name" \
        _wasm_stream_awk '
            index($0, "-> \"" ENVIRON["WASM_ARTIFACT_EXPORT_NAME"] "\"") { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
    fi
    # Raw bytes cannot distinguish an export name from an unrelated data
    # segment. Export completeness is a security/provenance predicate, so a
    # missing structural decoder is unsafe rather than evidence of presence.
    return 2
}

wasm_has_export() {
    wasm_has_wpk_fork_export "$@"
}

wasm_has_missing_exports() {
    local path="${1:-}"
    shift || true
    local name export_status
    for name in "$@"; do
        export_status=0
        wasm_has_export "$path" "$name" || export_status=$?
        case "$export_status" in
            0) ;;
            1) return 0 ;;
            *) return 0 ;; # Decoder failure: classify as unsafe/missing.
        esac
    done
    return 1
}

wasm_require_exports() {
    local path="${1:-}"
    shift || true
    local missing=()
    local name export_status decoder_failed=0
    for name in "$@"; do
        export_status=0
        wasm_has_export "$path" "$name" || export_status=$?
        case "$export_status" in
            0) ;;
            1) missing+=("$name") ;;
            *) decoder_failed=1 ;;
        esac
    done
    if [ "$decoder_failed" -eq 1 ]; then
        echo "ERROR: unable to inspect required wasm exports: $path" >&2
        return 1
    fi
    if [ ${#missing[@]} -gt 0 ]; then
        echo "ERROR: refusing wasm artifact missing required exports: $path" >&2
        printf '       missing: %s\n' "${missing[*]}" >&2
        return 1
    fi
}

wasm_reject_exports() {
    local path="${1:-}"
    shift || true
    local present=()
    local name export_status decoder_failed=0
    for name in "$@"; do
        export_status=0
        wasm_has_export "$path" "$name" || export_status=$?
        case "$export_status" in
            0) present+=("$name") ;;
            1) ;;
            *) decoder_failed=1 ;;
        esac
    done
    if [ "$decoder_failed" -eq 1 ]; then
        echo "ERROR: unable to inspect forbidden wasm exports: $path" >&2
        return 1
    fi
    if [ ${#present[@]} -gt 0 ]; then
        echo "ERROR: refusing wasm artifact with forbidden exports: $path" >&2
        printf '       forbidden: %s\n' "${present[*]}" >&2
        return 1
    fi
}

wasm_require_target_aware_exec_authority() {
    local path="${1:-}"
    wasm_require_exports "$path" \
        kernel_exec_target_prepare \
        kernel_spawn_exec_target_prepare \
        kernel_exec_target_size \
        kernel_exec_target_read \
        kernel_exec_target_cancel \
        kernel_exec_commit \
        kernel_publish_spawn_child \
        kernel_spawn_exec_commit &&
        wasm_reject_exports "$path" \
            kernel_exec_prepare \
            kernel_exec_setup \
            kernel_exec_setup_for_thread \
            kernel_execve \
            kernel_execveat
}

wasm_has_complete_fork_instrumentation() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork frame_reserve frame_commit frame_next linked_descriptor fork_capability
    local abort_begin abort_end rewind_begin rewind_end state unwind_begin unwind_end
    local memory_count memory64_count signature_mismatch legacy_dlopen native_start extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    [ "$inventory_status" -eq 0 ] || return "$inventory_status"
    IFS=$'\t' read -r relocatable imports_fork frame_reserve frame_commit frame_next \
        linked_descriptor fork_capability abort_begin abort_end rewind_begin rewind_end state \
        unwind_begin unwind_end memory_count memory64_count signature_mismatch legacy_dlopen native_start extra <<< "$inventory"
    [ -z "$extra" ] || return 2
    [ "$frame_reserve$frame_commit$frame_next" = 111 ] || return 1
    [ "$linked_descriptor" = 1 ] || return 1
    [ "$fork_capability" = 1 ] || return 1
    wasm_has_activation_state_safe_capability "$path" || return $?
    [ "$abort_begin$abort_end$rewind_begin$rewind_end$state$unwind_begin$unwind_end" = 1111111 ] ||
        return 1
    [ "$memory_count" = 1 ] && [ "$signature_mismatch" = 0 ] &&
        [ "$legacy_dlopen" = 0 ] && [ "$native_start" = 0 ] || return 1
    local descriptor_pointer_width
    descriptor_pointer_width="$(wasm_linked_frame_descriptor_pointer_width "$path")" || return $?
    [ "$descriptor_pointer_width" = 8 ] && [ "$memory64_count" = 1 ] && return 0
    [ "$descriptor_pointer_width" = 4 ] && [ "$memory64_count" = 0 ]
}

wasm_is_relocatable_object() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    if command -v wasm-objdump >/dev/null 2>&1; then
        _wasm_stream_awk '
            /name: "(linking|reloc\.)/ { found = 1 }
            END { exit(found ? 0 : 1) }
        ' wasm-objdump -x "$path"
        return
    fi
    case "$path" in
        *.o) return 0 ;;
        *) return 1 ;;
    esac
}

wasm_memory_arch() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 1
    command -v wasm-objdump >/dev/null 2>&1 || return 2
    _wasm_stream_awk '
        / - memory\[[0-9]+\] pages:/ {
            count += 1
            arch = ($0 ~ / i64( |$)/) ? "wasm64" : "wasm32"
        }
        END {
            if (count != 1) exit 2
            print arch
        }
    ' wasm-objdump -x "$path"
}

wasm_has_any_wpk_fork_export() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork frame_reserve frame_commit frame_next linked_descriptor fork_capability
    local abort_begin abort_end rewind_begin rewind_end state unwind_begin unwind_end
    local memory_count memory64_count signature_mismatch legacy_dlopen native_start extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    case "$inventory_status" in
        0) ;;
        1) return 1 ;;
        *) return 0 ;; # Decoder failure: classify as unsafe/present.
    esac
    IFS=$'\t' read -r relocatable imports_fork frame_reserve frame_commit frame_next \
        linked_descriptor fork_capability abort_begin abort_end rewind_begin rewind_end state \
        unwind_begin unwind_end memory_count memory64_count signature_mismatch legacy_dlopen native_start extra <<< "$inventory"
    [ -z "$extra" ] || return 0
    [ "$abort_begin$abort_end$rewind_begin$rewind_end$state$unwind_begin$unwind_end" != 0000000 ]
}

wasm_has_any_fork_instrumentation() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork frame_reserve frame_commit frame_next linked_descriptor fork_capability
    local abort_begin abort_end rewind_begin rewind_end state unwind_begin unwind_end
    local memory_count memory64_count signature_mismatch legacy_dlopen native_start extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    case "$inventory_status" in
        0) ;;
        1) return 1 ;;
        *) return 0 ;; # Decoder failure: classify as unsafe/present.
    esac
    IFS=$'\t' read -r relocatable imports_fork frame_reserve frame_commit frame_next \
        linked_descriptor fork_capability abort_begin abort_end rewind_begin rewind_end state \
        unwind_begin unwind_end memory_count memory64_count signature_mismatch legacy_dlopen native_start extra <<< "$inventory"
    [ -z "$extra" ] || return 0
    [ "$frame_reserve$frame_commit$frame_next" != 000 ] ||
        [ "$linked_descriptor" != 0 ] ||
        [ "$fork_capability" != 0 ] ||
        [ "$abort_begin$abort_end$rewind_begin$rewind_end$state$unwind_begin$unwind_end" != 0000000 ]
}

wasm_has_missing_fork_instrumentation() {
    local path="${1:-}"
    local inventory inventory_status=0
    local relocatable imports_fork frame_reserve frame_commit frame_next linked_descriptor fork_capability
    local abort_begin abort_end rewind_begin rewind_end state unwind_begin unwind_end
    local memory_count memory64_count signature_mismatch legacy_dlopen native_start extra
    wasm_is_binary "$path" || return 1

    if ! _wasm_fork_contract_inventory_decoder_available; then
        case "$path" in
            *.o) return 1 ;;
            *) return 0 ;;
        esac
    fi

    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    [ "$inventory_status" -eq 0 ] || return 0 # Decoder failure: unsafe.
    IFS=$'\t' read -r relocatable imports_fork frame_reserve frame_commit frame_next \
        linked_descriptor fork_capability abort_begin abort_end rewind_begin rewind_end state \
        unwind_begin unwind_end memory_count memory64_count signature_mismatch legacy_dlopen native_start extra <<< "$inventory"
    [ -z "$extra" ] || return 0
    [ "$relocatable" = 1 ] && return 1

    local frame_imports="$frame_reserve$frame_commit$frame_next"
    local exports="$abort_begin$abort_end$rewind_begin$rewind_end$state$unwind_begin$unwind_end"
    [ "$imports_fork" = 0 ] && [ "$frame_imports" = 000 ] &&
        [ "$linked_descriptor" = 0 ] && [ "$fork_capability" = 0 ] &&
        [ "$exports" = 0000000 ] && return 1

    [ "$linked_descriptor" = 1 ] || return 0
    [ "$fork_capability" = 1 ] || return 0
    wasm_has_activation_state_safe_capability "$path" || return 0
    local descriptor_pointer_width
    descriptor_pointer_width="$(wasm_linked_frame_descriptor_pointer_width "$path")" || return 0
    [ "$exports" = 1111111 ] || return 0
    [ "$memory_count" = 1 ] && [ "$signature_mismatch" = 0 ] &&
        [ "$legacy_dlopen" = 0 ] && [ "$native_start" = 0 ] || return 0
    if [ "$descriptor_pointer_width" = 8 ]; then
        [ "$memory64_count" = 1 ] || return 0
    else
        [ "$memory64_count" = 0 ] || return 0
    fi

    # No-seed instrumentation exports an inert runtime and descriptor without
    # importing frame hooks. A real fork seed or any hook makes the complete
    # three-import transaction mandatory.
    if [ "$imports_fork" = 1 ] || [ "$frame_imports" != 000 ]; then
        [ "$frame_imports" = 111 ] || return 0
    fi
    return 1
}

wasm_require_fork_instrumentation_if_needed() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 0

    if ! _wasm_fork_contract_inventory_decoder_available; then
        case "$path" in
            *.o) return 0 ;;
        esac
        echo "ERROR: unable to inspect fork instrumentation: $path" >&2
        echo "       wasm-fork-instrument or wasm-objdump is required for structural validation." >&2
        return 1
    fi

    local inventory inventory_status=0
    local relocatable imports_fork frame_reserve frame_commit frame_next linked_descriptor fork_capability
    local abort_begin abort_end rewind_begin rewind_end state unwind_begin unwind_end
    local memory_count memory64_count signature_mismatch legacy_dlopen native_start extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    if [ "$inventory_status" -ne 0 ]; then
        echo "ERROR: unable to inspect fork instrumentation: $path" >&2
        echo "       structural decoder failed with status $inventory_status." >&2
        return 1
    fi
    IFS=$'\t' read -r relocatable imports_fork frame_reserve frame_commit frame_next \
        linked_descriptor fork_capability abort_begin abort_end rewind_begin rewind_end state \
        unwind_begin unwind_end memory_count memory64_count signature_mismatch legacy_dlopen native_start extra <<< "$inventory"
    if [ -n "$extra" ]; then
        echo "ERROR: unable to inspect fork instrumentation: $path" >&2
        echo "       structural decoder returned an invalid fork-contract inventory." >&2
        return 1
    fi
    [ "$relocatable" = 1 ] && return 0

    local frame_imports="$frame_reserve$frame_commit$frame_next"
    local exports="$abort_begin$abort_end$rewind_begin$rewind_end$state$unwind_begin$unwind_end"
    local maybe_side_module=0
    grep -a -q 'dylink\.0' "$path" && maybe_side_module=1
    [ "$imports_fork" = 0 ] && [ "$frame_imports" = 000 ] &&
        [ "$linked_descriptor" = 0 ] && [ "$fork_capability" = 0 ] &&
        [ "$exports" = 0000000 ] && [ "$maybe_side_module" = 0 ] && return 0

    local artifact_role role_status=0
    artifact_role="$(wasm_artifact_role "$path")" || role_status=$?
    if [ "$role_status" -ne 0 ]; then
        echo "ERROR: unable to classify wasm artifact role: $path" >&2
        return 1
    fi

    local missing=()
    local duplicates=()
    [ "$abort_begin" -ge 1 ] || missing+=(wpk_fork_abort_begin)
    [ "$abort_end" -ge 1 ] || missing+=(wpk_fork_abort_end)
    [ "$rewind_begin" -ge 1 ] || missing+=(wpk_fork_rewind_begin)
    [ "$rewind_end" -ge 1 ] || missing+=(wpk_fork_rewind_end)
    [ "$state" -ge 1 ] || missing+=(wpk_fork_state)
    [ "$unwind_begin" -ge 1 ] || missing+=(wpk_fork_unwind_begin)
    [ "$unwind_end" -ge 1 ] || missing+=(wpk_fork_unwind_end)
    [ "$abort_begin" -le 1 ] || duplicates+=(wpk_fork_abort_begin)
    [ "$abort_end" -le 1 ] || duplicates+=(wpk_fork_abort_end)
    [ "$rewind_begin" -le 1 ] || duplicates+=(wpk_fork_rewind_begin)
    [ "$rewind_end" -le 1 ] || duplicates+=(wpk_fork_rewind_end)
    [ "$state" -le 1 ] || duplicates+=(wpk_fork_state)
    [ "$unwind_begin" -le 1 ] || duplicates+=(wpk_fork_unwind_begin)
    [ "$unwind_end" -le 1 ] || duplicates+=(wpk_fork_unwind_end)

    if [ "$imports_fork" = 1 ] || [ "$frame_imports" != 000 ]; then
        [ "$frame_reserve" -ge 1 ] || missing+=(env.__wpk_fork_frame_reserve)
        [ "$frame_commit" -ge 1 ] || missing+=(env.__wpk_fork_frame_commit)
        [ "$frame_next" -ge 1 ] || missing+=(env.__wpk_fork_frame_next)
        [ "$frame_reserve" -le 1 ] || duplicates+=(env.__wpk_fork_frame_reserve)
        [ "$frame_commit" -le 1 ] || duplicates+=(env.__wpk_fork_frame_commit)
        [ "$frame_next" -le 1 ] || duplicates+=(env.__wpk_fork_frame_next)
    fi

    local descriptor_error=""
    local descriptor_pointer_width=""
    if [ "$linked_descriptor" = 0 ]; then
        descriptor_error="missing kandelo.wpk_fork.linked_frames descriptor"
    elif [ "$linked_descriptor" != 1 ]; then
        descriptor_error="found $linked_descriptor kandelo.wpk_fork.linked_frames descriptors; expected exactly one"
    elif ! descriptor_pointer_width="$(wasm_linked_frame_descriptor_pointer_width "$path")"; then
        descriptor_error="kandelo.wpk_fork.linked_frames descriptor is malformed or unsupported"
    fi

    local capability_error=""
    if [ "$fork_capability" = 0 ]; then
        capability_error="missing kandelo.wpk_fork.capabilities"
    elif [ "$fork_capability" != 1 ]; then
        capability_error="found $fork_capability kandelo.wpk_fork.capabilities sections; expected exactly one"
    elif ! wasm_has_activation_state_safe_capability "$path"; then
        capability_error="capability is malformed or omits activation-state safety"
    elif [ "$artifact_role" = side-module ] &&
        ! wasm_has_side_entry_capability "$path"; then
        capability_error="side-module capability omits complete side-boundary coverage"
    fi

    local memory_error=""
    if [ "$memory_count" != 1 ]; then
        memory_error="ABI 43 fork instrumentation requires exactly one module memory; found $memory_count"
    elif [ -n "$descriptor_pointer_width" ]; then
        local memory_width_mismatch=0
        if [ "$descriptor_pointer_width" = 8 ] && [ "$memory64_count" != 1 ]; then
            memory_width_mismatch=1
        elif [ "$descriptor_pointer_width" = 4 ] && [ "$memory64_count" != 0 ]; then
            memory_width_mismatch=1
        fi
        if [ "$memory_width_mismatch" = 1 ]; then
            local memory_pointer_width=4
            local descriptor_article=a
            [ "$memory64_count" = 0 ] || memory_pointer_width=8
            [ "$descriptor_pointer_width" != 8 ] || descriptor_article=an
            # WHY: the host invokes continuation exports using the module memory's
            # actual address type. A descriptor that claims another width would
            # make an otherwise well-named artifact fail only after publication.
            memory_error="descriptor declares ${descriptor_article} ${descriptor_pointer_width}-byte pointer but module memory uses ${memory_pointer_width}-byte addresses"
        fi
    fi

    local signature_error=""
    [ "$signature_mismatch" = 0 ] ||
        signature_error="$signature_mismatch ABI 43 fork import/export signatures do not match module memory"
    local legacy_loader_error=""
    [ "$legacy_dlopen" = 0 ] ||
        legacy_loader_error="retains reentrant env.__wasm_dlopen instead of the staged loader lowering"
    local native_start_error=""
    [ "$native_start" = 0 ] ||
        native_start_error="retains a native Wasm start section instead of deferring initialization to wpk_fork_module_bootstrap"

    if [ ${#missing[@]} -eq 0 ] && [ ${#duplicates[@]} -eq 0 ] &&
        [ -z "$descriptor_error" ] && [ -z "$capability_error" ] &&
        [ -z "$memory_error" ] &&
        [ -z "$signature_error" ] && [ -z "$legacy_loader_error" ] &&
        [ -z "$native_start_error" ]; then
        return 0
    fi

    echo "ERROR: refusing wasm artifact with incomplete ABI 43 fork instrumentation: $path" >&2
    [ ${#missing[@]} -eq 0 ] || printf '       missing: %s\n' "${missing[*]}" >&2
    [ ${#duplicates[@]} -eq 0 ] || printf '       duplicate: %s\n' "${duplicates[*]}" >&2
    [ -z "$descriptor_error" ] || printf '       descriptor: %s\n' "$descriptor_error" >&2
    [ -z "$capability_error" ] || printf '       capability: %s\n' "$capability_error" >&2
    [ -z "$memory_error" ] || printf '       memory: %s\n' "$memory_error" >&2
    [ -z "$signature_error" ] || printf '       signatures: %s\n' "$signature_error" >&2
    [ -z "$legacy_loader_error" ] || printf '       loader: %s\n' "$legacy_loader_error" >&2
    [ -z "$native_start_error" ] || printf '       start: %s\n' "$native_start_error" >&2
    echo "       Fork-capable binaries must be processed with scripts/run-wasm-fork-instrument.sh from the current ABI." >&2
    return 1
}

wasm_require_no_fork_instrumentation() {
    local path="${1:-}"
    wasm_is_binary "$path" || return 0
    local inventory inventory_status=0
    local relocatable imports_fork frame_reserve frame_commit frame_next linked_descriptor fork_capability
    local abort_begin abort_end rewind_begin rewind_end state unwind_begin unwind_end
    local memory_count memory64_count signature_mismatch legacy_dlopen native_start extra
    inventory="$(_wasm_fork_contract_inventory "$path")" || inventory_status=$?
    if [ "$inventory_status" -ne 0 ]; then
        echo "ERROR: unable to inspect fork instrumentation policy: $path" >&2
        return 1
    fi
    IFS=$'\t' read -r relocatable imports_fork frame_reserve frame_commit frame_next \
        linked_descriptor fork_capability abort_begin abort_end rewind_begin rewind_end state \
        unwind_begin unwind_end memory_count memory64_count signature_mismatch legacy_dlopen native_start extra <<< "$inventory"
    if [ -n "$extra" ]; then
        echo "ERROR: unable to inspect fork instrumentation policy: $path" >&2
        return 1
    fi
    if [ "$frame_reserve$frame_commit$frame_next" != 000 ] ||
        [ "$linked_descriptor" != 0 ] ||
        [ "$fork_capability" != 0 ] ||
        [ "$abort_begin$abort_end$rewind_begin$rewind_end$state$unwind_begin$unwind_end" != 0000000 ]; then
        echo "ERROR: refusing wasm artifact with disabled fork instrumentation policy: $path" >&2
        echo "       Rebuild it without scripts/run-wasm-fork-instrument.sh." >&2
        return 1
    fi
}
