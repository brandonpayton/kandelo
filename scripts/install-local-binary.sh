#!/usr/bin/env bash
#
# Install freshly-built package artifacts into local-binaries/. Normal local
# installs are manifest-driven and fail closed: one Rust metadata lookup
# selects the exact output path and fork policy before source instrumentation
# or destination mutation. Sealed package builds may avoid Cargo only by
# disabling the local mirror and explicitly declaring the fork policy.
#
# Usage:
#   source scripts/install-local-binary.sh
#   install_local_binary <package> <source> [declared-output-artifact]
#   install_local_runtime_file <package> <source> [declared-runtime-artifact]
#
# The optional artifact is the exact `[[outputs]].wasm` or
# `[[runtime_files]].artifact` path. A source basename is accepted only when it
# identifies one output unambiguously.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wasm-artifact-guards.sh"

if [ -z "${WASM_POSIX_LOCAL_INSTALL_SESSION:-}" ]; then
    WASM_POSIX_LOCAL_INSTALL_SESSION="shell-${BASHPID:-$$}-${RANDOM:-0}-${RANDOM:-0}"
fi

_wasm_posix_require_portable_relative_path() {
    case "$1" in
        ""|/*|*\\*|.|..|./*|../*|*/.|*/..|*//*|*/./*|*/../*|*/)
            return 1
            ;;
    esac
}

_wasm_posix_directory_identity() {
    local path="$1"
    local identity
    if [ ! -d "$path" ] || [ -L "$path" ]; then
        return 1
    fi
    if identity="$(stat -c '%d:%i:%u:%g:%a' "$path" 2>/dev/null)"; then
        printf '%s\n' "$identity"
        return
    fi
    identity="$(stat -f '%d:%i:%u:%g:%Lp' "$path" 2>/dev/null)" || return
    printf '%s\n' "$identity"
}

_wasm_posix_sha256_file() {
    local path="$1"
    local output
    if command -v sha256sum >/dev/null 2>&1; then
        output="$(sha256sum "$path")" || return
    elif command -v shasum >/dev/null 2>&1; then
        output="$(shasum -a 256 "$path")" || return
    elif command -v openssl >/dev/null 2>&1; then
        output="$(openssl dgst -sha256 "$path")" || return
        printf '%s\n' "${output##* }"
        return
    else
        echo "install-local-binary: no SHA-256 implementation is available" >&2
        return 1
    fi
    printf '%s\n' "${output%% *}"
}

# The filesystem identity plus exact bytes of one regular file. Cleanup uses
# this state to avoid deleting a path that another writer replaced or changed.
_wasm_posix_regular_file_state() {
    local path="$1"
    local identity digest
    if [ ! -f "$path" ] || [ -L "$path" ]; then
        return 1
    fi
    if ! identity="$(stat -c '%d:%i:%u:%g:%a:%s' "$path" 2>/dev/null)"; then
        identity="$(stat -f '%d:%i:%u:%g:%Lp:%z' "$path" 2>/dev/null)" || return
    fi
    digest="$(_wasm_posix_sha256_file "$path")" || return
    printf '%s:%s\n' "$identity" "$digest"
}

# Shell path operations cannot provide openat-style race freedom. The sealed
# install contract therefore requires a caller-owned, single-writer scratch
# root. Enforce the observable part of that contract: this user owns every
# directory we traverse and no group/other writer can replace its entries.
_wasm_posix_require_single_writer_directory() {
    local path="$1"
    local label="$2"
    local identity="${3:-}"
    if [ -z "$identity" ]; then
        identity="$(_wasm_posix_directory_identity "$path")" || {
            echo "install-local-binary: $label must be a real directory: $path" >&2
            return 1
        }
    fi
    local device inode owner group mode
    IFS=: read -r device inode owner group mode <<<"$identity"
    if [ "$owner" != "$(id -u)" ]; then
        echo "install-local-binary: $label must be owned by the current user: $path" >&2
        return 1
    fi
    if ! [[ "$mode" =~ ^[0-7]{3,4}$ ]] || (( (8#$mode & 8#022) != 0 )); then
        echo "install-local-binary: $label must not be writable by group or other users: $path" >&2
        return 1
    fi
}

_wasm_posix_require_unchanged_directory() {
    local path="$1"
    local expected="$2"
    local label="$3"
    local actual
    actual="$(_wasm_posix_directory_identity "$path")" || {
        echo "install-local-binary: $label changed or disappeared; preserving transaction state: $path" >&2
        return 1
    }
    if [ "$actual" != "$expected" ]; then
        echo "install-local-binary: $label changed filesystem identity; preserving transaction state: $path" >&2
        return 1
    fi
}

_wasm_posix_remove_unchanged_transaction_file() {
    local transaction="$1"
    local transaction_identity="$2"
    local path="$3"
    local expected="$4"
    local label="$5"
    local actual
    _wasm_posix_require_unchanged_directory \
        "$transaction" "$transaction_identity" "private transaction directory" || return
    actual="$(_wasm_posix_regular_file_state "$path")" || {
        echo "install-local-binary: $label changed type or disappeared; refusing cleanup: $path" >&2
        return 1
    }
    if [ "$actual" != "$expected" ]; then
        echo "install-local-binary: $label changed identity or contents; refusing cleanup: $path" >&2
        return 1
    fi
    rm -f "$path" || return
    if [ -e "$path" ] || [ -L "$path" ]; then
        echo "install-local-binary: $label remained after cleanup: $path" >&2
        return 1
    fi
}

# Copy below one authorized caller-owned scratch directory. Every
# created/existing descendant directory is checked without following symlinks,
# and publication uses a private transaction plus create-once hard link. The
# caller must keep the root single-writer for the duration of this function;
# general shared-directory race freedom requires dirfd/openat operations and is
# intentionally not claimed by this packaging-only shell path.
_wasm_posix_copy_file_no_follow() {
    local src="$1"
    local authorized_root="$2"
    local relative_dest="$3"

    if [ ! -f "$src" ] || [ -L "$src" ]; then
        echo "install-local-binary: source must be a regular non-symlink file: $src" >&2
        return 1
    fi
    if [ ! -d "$authorized_root" ] || [ -L "$authorized_root" ]; then
        echo "install-local-binary: authorized destination root must be a real directory: $authorized_root" >&2
        return 1
    fi
    if ! _wasm_posix_require_portable_relative_path "$relative_dest"; then
        echo "install-local-binary: destination must be a normalized portable relative path: $relative_dest" >&2
        return 1
    fi

    local root
    root="$(cd "$authorized_root" && pwd -P)" || return 1
    local root_identity
    root_identity="$(_wasm_posix_directory_identity "$root")" || return 1
    _wasm_posix_require_single_writer_directory \
        "$root" "authorized destination root" "$root_identity" || return
    local parent_relative
    parent_relative="$(dirname "$relative_dest")"
    local parent="$root"
    if [ "$parent_relative" != "." ]; then
        local remainder="$parent_relative"
        while [ -n "$remainder" ]; do
            local component="${remainder%%/*}"
            if [ "$component" = "$remainder" ]; then
                remainder=""
            else
                remainder="${remainder#*/}"
            fi
            local next="$parent/$component"
            if [ -L "$next" ]; then
                echo "install-local-binary: refusing destination symlink ancestor: $next" >&2
                return 1
            fi
            if [ -e "$next" ]; then
                if [ ! -d "$next" ]; then
                    echo "install-local-binary: destination ancestor is not a directory: $next" >&2
                    return 1
                fi
            elif ! mkdir -m 755 "$next"; then
                return 1
            fi
            _wasm_posix_require_single_writer_directory \
                "$next" "destination ancestor" || return
            parent="$next"
        done
    fi

    local parent_identity
    parent_identity="$(_wasm_posix_directory_identity "$parent")" || return 1
    local source_state
    source_state="$(_wasm_posix_regular_file_state "$src")" || {
        echo "install-local-binary: could not capture source identity and contents: $src" >&2
        return 1
    }

    local dest="$root/$relative_dest"
    local transaction
    transaction="$(mktemp -d "$root/.kandelo-install.XXXXXX")" || return 1
    chmod 700 "$transaction" || {
        echo "install-local-binary: could not protect transaction directory: $transaction" >&2
        return 1
    }
    local transaction_identity
    transaction_identity="$(_wasm_posix_directory_identity "$transaction")" || return 1
    _wasm_posix_require_single_writer_directory \
        "$transaction" "private transaction directory" "$transaction_identity" || return
    local stage="$transaction/stage"
    local backup="$transaction/backup"

    if ! cp -p "$src" "$stage"; then
        echo "install-local-binary: source copy failed; preserving transaction state: $transaction" >&2
        return 1
    fi
    local source_after stage_state
    source_after="$(_wasm_posix_regular_file_state "$src")" || return 1
    stage_state="$(_wasm_posix_regular_file_state "$stage")" || return 1
    if [ "$source_after" != "$source_state" ] || \
       [ "${stage_state##*:}" != "${source_state##*:}" ]; then
        echo "install-local-binary: source changed during copy; preserving transaction state: $transaction" >&2
        return 1
    fi
    _wasm_posix_require_unchanged_directory \
        "$root" "$root_identity" "authorized destination root" || return
    _wasm_posix_require_unchanged_directory \
        "$parent" "$parent_identity" "destination parent" || return
    _wasm_posix_require_unchanged_directory \
        "$transaction" "$transaction_identity" "private transaction directory" || return

    local old_moved=0
    local old_state=""
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        if [ -d "$dest" ] && [ ! -L "$dest" ]; then
            echo "install-local-binary: refusing to replace directory: $dest" >&2
            return 1
        fi
        if [ -L "$dest" ] || [ ! -f "$dest" ]; then
            echo "install-local-binary: refusing to replace a non-regular destination: $dest" >&2
            return 1
        fi
        old_state="$(_wasm_posix_regular_file_state "$dest")" || return 1
        if ! mv "$dest" "$backup"; then
            return 1
        fi
        old_moved=1
        local quarantined_state=""
        quarantined_state="$(_wasm_posix_regular_file_state "$backup")" || true
        if [ "$quarantined_state" != "$old_state" ]; then
            echo "install-local-binary: destination changed during quarantine; refusing publication" >&2
            if [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
                # Preserve the entry that won the pathname race by returning
                # it to the live name. Never delete an unrecognized backup.
                mv "$backup" "$dest" || {
                    echo "install-local-binary: could not restore changed quarantine; preserved it at $backup" >&2
                    return 1
                }
            fi
            return 1
        fi
    fi

    if ! ln "$stage" "$dest"; then
        if [ "$old_moved" = "1" ] && [ ! -e "$dest" ] && [ ! -L "$dest" ]; then
            local rollback_state
            rollback_state="$(_wasm_posix_regular_file_state "$backup")" || {
                echo "install-local-binary: refusing to restore changed quarantine: $backup" >&2
                return 1
            }
            if [ "$rollback_state" != "$old_state" ]; then
                echo "install-local-binary: refusing to restore changed quarantine: $backup" >&2
                return 1
            fi
            if ! mv "$backup" "$dest" || \
               [ "$(_wasm_posix_regular_file_state "$dest" || true)" != "$old_state" ]; then
                echo "install-local-binary: failed to restore the previous destination: $dest" >&2
                return 1
            fi
        fi
        echo "install-local-binary: publication failed; preserving transaction state: $transaction" >&2
        return 1
    fi

    local published_stage_state published_dest_state
    published_stage_state="$(_wasm_posix_regular_file_state "$stage")" || return 1
    published_dest_state="$(_wasm_posix_regular_file_state "$dest")" || return 1
    if [ "$published_stage_state" != "$published_dest_state" ] || \
       [ "${published_dest_state##*:}" != "${source_state##*:}" ]; then
        echo "install-local-binary: published destination changed identity or contents; preserving transaction state: $transaction" >&2
        return 1
    fi

    if [ "$old_moved" = "1" ]; then
        local final_backup_state
        final_backup_state="$(_wasm_posix_regular_file_state "$backup")" || {
            echo "install-local-binary: quarantined destination changed type or disappeared; preserving transaction state: $transaction" >&2
            return 1
        }
        if [ "$final_backup_state" != "$old_state" ]; then
            echo "install-local-binary: quarantined destination changed identity or contents; preserving transaction state: $transaction" >&2
            return 1
        fi
    fi

    _wasm_posix_remove_unchanged_transaction_file \
        "$transaction" "$transaction_identity" "$stage" \
        "$published_stage_state" "staged artifact" || return
    if [ "$(_wasm_posix_regular_file_state "$dest" || true)" != "$published_dest_state" ]; then
        echo "install-local-binary: published destination changed during staged-link cleanup: $dest" >&2
        return 1
    fi
    if [ "$old_moved" = "1" ]; then
        _wasm_posix_remove_unchanged_transaction_file \
            "$transaction" "$transaction_identity" "$backup" \
            "$old_state" "quarantined destination" || return
    fi
    if [ "$(_wasm_posix_regular_file_state "$dest" || true)" != "$published_dest_state" ]; then
        echo "install-local-binary: published destination changed during transaction cleanup: $dest" >&2
        return 1
    fi
    _wasm_posix_require_unchanged_directory \
        "$transaction" "$transaction_identity" "private transaction directory" || return
    rmdir "$transaction" || {
        echo "install-local-binary: private transaction is not empty; refusing recursive cleanup: $transaction" >&2
        return 1
    }
}

_wasm_posix_output_metadata() {
    local repo_root="$1"
    local host_target="$2"
    local package="$3"
    local artifact="$4"
    (
        cd "$repo_root"
        env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
            AR="${LLVM_BIN:?install-local-binary: LLVM_BIN is required}/llvm-ar" \
            RANLIB="${LLVM_BIN:?install-local-binary: LLVM_BIN is required}/llvm-ranlib" \
            cargo run -p xtask --target "$host_target" --quiet -- \
                build-deps output-metadata "$package" "$artifact"
    )
}

install_local_binary() {
    local program="${1:-}"
    local src="${2:-}"
    local requested_artifact="${3:-}"
    if [ -z "$program" ] || [ -z "$src" ]; then
        echo "install_local_binary: usage: install_local_binary <package> <source> [declared-output-artifact]" >&2
        return 2
    fi
    if [ ! -f "$src" ] || [ -L "$src" ]; then
        echo "install_local_binary: source must be a regular non-symlink file: $src" >&2
        return 1
    fi

    local arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
    case "$arch" in
        wasm32|wasm64) ;;
        *)
            echo "install_local_binary: unsupported target arch '$arch' (expected wasm32 or wasm64)" >&2
            return 2
            ;;
    esac

    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local src_basename
    src_basename="$(basename "$src")"
    requested_artifact="${requested_artifact:-$src_basename}"
    if ! _wasm_posix_require_portable_relative_path "$requested_artifact"; then
        echo "install_local_binary: declared artifact must be a normalized portable relative path: $requested_artifact" >&2
        return 2
    fi

    local install_local_mirror="${WASM_POSIX_INSTALL_LOCAL_MIRROR:-1}"
    case "$install_local_mirror" in
        0)
            if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
                echo "install_local_binary: WASM_POSIX_INSTALL_LOCAL_MIRROR=0 requires WASM_POSIX_DEP_OUT_DIR" >&2
                return 2
            fi
            ;;
        1) ;;
        *)
            echo "install_local_binary: unsupported WASM_POSIX_INSTALL_LOCAL_MIRROR='$install_local_mirror' (expected 0 or 1)" >&2
            return 2
            ;;
    esac

    local host_target=""
    local mirror_path=""
    local declared_artifact="$requested_artifact"
    local declared_policy=""
    if [ "$install_local_mirror" = "1" ]; then
        host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
        if [ -z "$host_target" ]; then
            echo "install_local_binary: rustc did not report a host target" >&2
            return 1
        fi

        # Resolve destination and policy together before any operation below
        # can instrument the source or mutate a destination.
        local metadata
        if ! metadata="$(_wasm_posix_output_metadata \
            "$repo_root" "$host_target" "$program" "$requested_artifact")"; then
            echo "install_local_binary: package '$program' does not uniquely declare output '$requested_artifact'" >&2
            return 1
        fi
        local fields
        if ! fields="$(node -e '
            const value = JSON.parse(process.argv[1]);
            for (const key of ["mirror_path", "fork_instrumentation", "source_artifact"]) {
              if (typeof value[key] !== "string" || value[key].length === 0 ||
                  value[key].includes("\t") || value[key].includes("\n")) {
                throw new Error(`invalid output metadata field ${key}`);
              }
            }
            process.stdout.write(
              `${value.mirror_path}\t${value.fork_instrumentation}\t${value.source_artifact}`,
            );
          ' "$metadata")"; then
            echo "install_local_binary: invalid output metadata for '$program:$requested_artifact'" >&2
            return 1
        fi
        IFS=$'\t' read -r mirror_path declared_policy declared_artifact <<<"$fields"
        if ! _wasm_posix_require_portable_relative_path "$mirror_path" \
            || ! _wasm_posix_require_portable_relative_path "$declared_artifact"; then
            echo "install_local_binary: xtask returned an unsafe output path" >&2
            return 1
        fi
    else
        declared_policy="${WASM_POSIX_INSTALL_FORK_INSTRUMENTATION:-}"
        if [ -z "$declared_policy" ]; then
            echo "install_local_binary: sealed installs require explicit WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto|disabled" >&2
            return 2
        fi
    fi

    local requested_policy="${WASM_POSIX_INSTALL_FORK_INSTRUMENTATION:-}"
    if [ "$install_local_mirror" = "1" ] \
        && [ -n "$requested_policy" ] \
        && [ "$requested_policy" != "$declared_policy" ]; then
        echo "install_local_binary: requested fork policy '$requested_policy' disagrees with package policy '$declared_policy'" >&2
        return 1
    fi

    if ! wasm_require_no_legacy_asyncify "$src"; then
        return 1
    fi
    if ! wasm_require_approved_reserved_env_imports "$src"; then
        return 1
    fi
    case "$declared_policy" in
        auto)
            local artifact_role=executable role_status=0 imports_migration_seed=0
            wasm_imports_migration_seed "$src" && imports_migration_seed=1
            # `dylink.0` is an exact Wasm custom-section name, so it is present
            # as plain bytes. Use that only as a cheap prefilter: structural
            # role classification remains authoritative for every candidate.
            # Ordinary Wasm and non-Wasm package data must not need the host
            # artifact-identity tool merely to prove that they are not sides.
            if wasm_is_binary "$src" && grep -a -q 'dylink\.0' "$src"; then
                artifact_role="$(wasm_artifact_role "$src")" || role_status=$?
                if [ "$role_status" -ne 0 ]; then
                    echo "install_local_binary: unable to classify wasm artifact role for '$src'" >&2
                    return 1
                fi
            fi
            if { [ "$imports_migration_seed" = 1 ] || [ "$artifact_role" = side-module ]; } \
                && ! wasm_has_complete_fork_instrumentation "$src"; then
                # WHY reject every partial ABI marker before reinstrumenting:
                # adding a second copy can turn one stale descriptor or frame
                # hook into an artifact that instantiates but corrupts replay.
                if wasm_has_any_fork_instrumentation "$src"; then
                    wasm_require_fork_instrumentation_if_needed "$src"
                    return 1
                fi
                echo "  applying wasm-fork-instrument to $(basename "$src")"
                local instrumented
                instrumented="$(mktemp "${TMPDIR:-/tmp}/wpk-fork-instrument.XXXXXX.wasm")"
                if ! "$repo_root/scripts/run-wasm-fork-instrument.sh" "$src" \
                    --checkpoint-entry kernel.kernel_checkpoint \
                    -o "$instrumented"; then
                    rm -f "$instrumented"
                    return 1
                fi
                mv "$instrumented" "$src"
            fi
            wasm_require_fork_instrumentation_if_needed "$src" || return 1
            ;;
        disabled)
            wasm_require_no_fork_instrumentation "$src" || return 1
            ;;
        *)
            echo "install_local_binary: unsupported fork policy '$declared_policy' (expected auto or disabled)" >&2
            return 2
            ;;
    esac

    if [ "$install_local_mirror" = "1" ]; then
        local source_parent
        source_parent="$(cd "$(dirname "$src")" && pwd -P)" || return 1
        local source_abs="$source_parent/$src_basename"
        if ! (
            cd "$repo_root"
            env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
                AR="${LLVM_BIN:?install-local-binary: LLVM_BIN is required}/llvm-ar" \
                RANLIB="${LLVM_BIN:?install-local-binary: LLVM_BIN is required}/llvm-ranlib" \
                WASM_POSIX_LOCAL_INSTALL_SOURCE="$source_abs" \
                WASM_POSIX_LOCAL_INSTALL_SESSION="$WASM_POSIX_LOCAL_INSTALL_SESSION" \
                cargo run -p xtask --target "$host_target" --quiet -- \
                    build-deps --arch "$arch" \
                    --binaries-dir "$repo_root/local-binaries" \
                    install-local-artifact "$program" "$declared_artifact"
        ); then
            return 1
        fi
    fi

    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        if ! _wasm_posix_copy_file_no_follow \
            "$src" "$WASM_POSIX_DEP_OUT_DIR" "$declared_artifact"; then
            echo "install_local_binary: failed to publish resolver scratch artifact: $WASM_POSIX_DEP_OUT_DIR/$declared_artifact" >&2
            return 1
        fi
        echo "  installed $WASM_POSIX_DEP_OUT_DIR/$declared_artifact (resolver scratch)"
    fi
}

install_local_runtime_file() {
    local program="${1:-}"
    local src="${2:-}"
    local artifact="${3:-}"
    if [ -z "$program" ] || [ -z "$src" ]; then
        echo "install_local_runtime_file: usage: install_local_runtime_file <package> <source> [declared-runtime-artifact]" >&2
        return 2
    fi
    if [ ! -f "$src" ] || [ -L "$src" ]; then
        echo "install_local_runtime_file: source must be a regular non-symlink file: $src" >&2
        return 1
    fi

    local arch="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
    case "$arch" in
        wasm32|wasm64) ;;
        *)
            echo "install_local_runtime_file: unsupported target arch '$arch' (expected wasm32 or wasm64)" >&2
            return 2
            ;;
    esac
    local repo_root
    repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    local src_basename
    src_basename="$(basename "$src")"
    artifact="${artifact:-$src_basename}"
    if ! _wasm_posix_require_portable_relative_path "$artifact"; then
        echo "install_local_runtime_file: artifact must be a portable relative path with normalized components: $artifact" >&2
        return 2
    fi

    local install_local_mirror="${WASM_POSIX_INSTALL_LOCAL_MIRROR:-1}"
    case "$install_local_mirror" in
        0)
            if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
                echo "install_local_runtime_file: WASM_POSIX_INSTALL_LOCAL_MIRROR=0 requires WASM_POSIX_DEP_OUT_DIR" >&2
                return 2
            fi
            if ! _wasm_posix_copy_file_no_follow \
                "$src" "$WASM_POSIX_DEP_OUT_DIR" "$artifact"; then
                echo "install_local_runtime_file: failed to publish resolver scratch artifact: $WASM_POSIX_DEP_OUT_DIR/$artifact" >&2
                return 1
            fi
            echo "  installed $WASM_POSIX_DEP_OUT_DIR/$artifact (resolver scratch)"
            return 0
            ;;
        1) ;;
        *)
            echo "install_local_runtime_file: unsupported WASM_POSIX_INSTALL_LOCAL_MIRROR='$install_local_mirror' (expected 0 or 1)" >&2
            return 2
            ;;
    esac

    local host_target
    host_target="$(rustc -vV 2>/dev/null | awk '/^host/ {print $2}')"
    if [ -z "$host_target" ]; then
        echo "install_local_runtime_file: rustc did not report a host target" >&2
        return 1
    fi
    local source_parent
    source_parent="$(cd "$(dirname "$src")" && pwd -P)" || return 1
    local source_abs="$source_parent/$src_basename"
    (
        cd "$repo_root"
        env -u CC -u CXX -u AR -u RANLIB -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
            AR="${LLVM_BIN:?install-local-binary: LLVM_BIN is required}/llvm-ar" \
            RANLIB="${LLVM_BIN:?install-local-binary: LLVM_BIN is required}/llvm-ranlib" \
            WASM_POSIX_LOCAL_INSTALL_SOURCE="$source_abs" \
            WASM_POSIX_LOCAL_INSTALL_SESSION="$WASM_POSIX_LOCAL_INSTALL_SESSION" \
            cargo run -p xtask --target "$host_target" --quiet -- \
                build-deps --arch "$arch" \
                --binaries-dir "$repo_root/local-binaries" \
                install-local-artifact "$program" "$artifact"
    )
}
