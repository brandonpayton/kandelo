#!/usr/bin/env bash
#
# Build libcurl or the curl CLI for wasm32 Kandelo.
#
# The resolver invokes this recipe for two package names:
#   libcurl  -> lib/libcurl.a, include/curl/, lib/pkgconfig/libcurl.pc
#   curl     -> curl.wasm
#
# Resolver builds use a disposable source tree and install only the outputs
# declared by that package. A direct invocation retains the historical
# curl-src/ tree because run.sh consumes its libcurl archive and headers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Use the SDK from this checkout rather than whichever npm link happens to be
# globally active.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

CURL_VERSION="${WASM_POSIX_DEP_VERSION:-${CURL_VERSION:-8.11.1}}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://curl.se/download/curl-${CURL_VERSION}.tar.xz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-c7ca7db48b0909743eaef34250da02c19bc61d4f1dcedd6603f109409536ab56}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
PACKAGE_NAME="${WASM_POSIX_DEP_NAME:-legacy}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: curl currently supports only wasm32, got $TARGET_ARCH" >&2
    exit 1
fi
CC="$(command -v wasm32posix-cc || true)"
AR="$(command -v wasm32posix-ar || true)"
NM="$(command -v wasm32posix-nm || true)"
for tool in "$CC" "$AR" "$NM"; do
    if [ -z "$tool" ] || ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required libcurl SDK tool is unavailable: ${tool:-<empty>}" >&2
        exit 1
    fi
done
for tool in curl make tar shasum wasm-objdump; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "ERROR: required libcurl host tool is unavailable: $tool" >&2
        exit 1
    fi
done

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-libcurl.XXXXXX")"
cleanup() {
    if [ "${WASM_POSIX_KEEP_BUILD_DIR:-0}" = "1" ]; then
        echo "==> Preserving curl build directory: $WORK_DIR" >&2
    else
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

RESOLVER_MODE=0
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    RESOLVER_MODE=1
    SRC_DIR="$WORK_DIR/source"
    INSTALL_DIR="$WASM_POSIX_DEP_OUT_DIR"
    STAGE_DIR="$WORK_DIR/stage"
else
    SRC_DIR="$SCRIPT_DIR/curl-src"
    INSTALL_DIR="$SCRIPT_DIR/bin"
    STAGE_DIR=""
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found at $SYSROOT; build musl first" >&2
    exit 1
fi
export WASM_POSIX_SYSROOT="$SYSROOT"

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:-}"
OPENSSL_PREFIX="${WASM_POSIX_DEP_OPENSSL_DIR:-}"
if [ "$RESOLVER_MODE" = "0" ]; then
    [ -n "$ZLIB_PREFIX" ] || ZLIB_PREFIX="$SYSROOT"
    [ -n "$OPENSSL_PREFIX" ] || OPENSSL_PREFIX="$SYSROOT"
fi
if [ ! -f "$ZLIB_PREFIX/lib/libz.a" ]; then
    echo "ERROR: declared zlib dependency is missing at $ZLIB_PREFIX" >&2
    exit 1
fi
if [ ! -f "$OPENSSL_PREFIX/lib/libssl.a" ] \
   || [ ! -f "$OPENSSL_PREFIX/lib/libcrypto.a" ]; then
    echo "ERROR: declared OpenSSL dependency is incomplete at $OPENSSL_PREFIX" >&2
    exit 1
fi

echo "==> Downloading curl $CURL_VERSION..."
TARBALL="$WORK_DIR/curl.tar.xz"
curl --retry 10 --retry-delay 5 --retry-max-time 300 \
    -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "==> Verifying source sha256..."
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
tar xJf "$TARBALL" -C "$SRC_DIR" --strip-components=1

cd "$SRC_DIR"

# Configure probes must reflect the wasm target, not the build host.
export ac_cv_func_closesocket=no
export ac_cv_func_CloseSocket=no
export ac_cv_func_fcntl=yes
export ac_cv_func_ioctl=yes
export ac_cv_func_fchmod=yes
export ac_cv_func_fnmatch=yes
export ac_cv_func_basename=yes
export ac_cv_func_connect=yes
export ac_cv_func_gethostname=yes
export ac_cv_func_gettimeofday=yes
export ac_cv_func_poll=yes
export ac_cv_func_select=yes
export ac_cv_func_socket=yes
export ac_cv_func_socketpair=yes
export ac_cv_func_getifaddrs=no
export ac_cv_func_if_nametoindex=no
export ac_cv_func_freeifaddrs=no
export ac_cv_func_getpwuid=yes
export ac_cv_func_getpwuid_r=no
export ac_cv_func_getrlimit=no
export ac_cv_func_setrlimit=no
export ac_cv_func_sigaction=yes
export ac_cv_func_sigsetjmp=yes
export ac_cv_func_alarm=yes
export ac_cv_func_strtoll=yes
export ac_cv_func_fsetxattr=no
export ac_cv_func_ftruncate=yes
export ac_cv_func_sched_yield=yes
export ac_cv_func_sendmsg=yes
export ac_cv_func_recvmsg=yes
export ac_cv_func_getpass_r=no
export ac_cv_func_arc4random=no

export ac_cv_sizeof_long=4
export ac_cv_sizeof_long_long=8
export ac_cv_sizeof_int=4
export ac_cv_sizeof_size_t=4
export ac_cv_sizeof_off_t=8
export ac_cv_sizeof_curl_off_t=8
export ac_cv_sizeof_time_t=8

export curl_cv_func_recv_args="int,void *,size_t,int,ssize_t"
export curl_cv_func_send_args="int,const void *,size_t,int,ssize_t"
export curl_cv_func_recvfrom_args="int,void *,size_t,int,struct sockaddr *,socklen_t *,ssize_t"
export curl_cv_recv=yes
export curl_cv_send=yes

# These libraries are resolver-validated above. Their unprototyped autoconf
# probes are not valid evidence on Wasm's typed call graph.
export ac_cv_lib_crypto_HMAC_Update=yes
export ac_cv_lib_crypto_HMAC_Init_ex=yes
export ac_cv_lib_ssl_SSL_connect=yes
export ac_cv_lib_crypto_EVP_DigestInit_ex=yes
export ac_cv_lib_dl_dlopen=yes
export ac_cv_lib_z_gzread=yes
export ac_cv_lib_z_inflateEnd=yes

export OPENSSL_CFLAGS="-I$OPENSSL_PREFIX/include"
export OPENSSL_LIBS="-L$OPENSSL_PREFIX/lib -lssl -lcrypto"
export LIBS="${LIBS:-} -ldl"

# libcurl.a is absorbed into PHP's curl.so side module. Compile every archive
# member as PIC, and map producer paths so the archive is reproducible across
# checkout and temporary-directory locations.
REPRO_FLAGS="-ffile-prefix-map=$WORK_DIR=/usr/src/curl-build"
REPRO_FLAGS+=" -fdebug-prefix-map=$WORK_DIR=/usr/src/curl-build"
REPRO_FLAGS+=" -fmacro-prefix-map=$WORK_DIR=/usr/src/curl-build"
REPRO_FLAGS+=" -ffile-prefix-map=$REPO_ROOT=/usr/src/kandelo"
REPRO_FLAGS+=" -fdebug-prefix-map=$REPO_ROOT=/usr/src/kandelo"
REPRO_FLAGS+=" -fmacro-prefix-map=$REPO_ROOT=/usr/src/kandelo"
REPRO_FLAGS+=" -ffile-prefix-map=$ZLIB_PREFIX=/usr/src/kandelo-deps/zlib"
REPRO_FLAGS+=" -fdebug-prefix-map=$ZLIB_PREFIX=/usr/src/kandelo-deps/zlib"
REPRO_FLAGS+=" -fmacro-prefix-map=$ZLIB_PREFIX=/usr/src/kandelo-deps/zlib"
REPRO_FLAGS+=" -ffile-prefix-map=$OPENSSL_PREFIX=/usr/src/kandelo-deps/openssl"
REPRO_FLAGS+=" -fdebug-prefix-map=$OPENSSL_PREFIX=/usr/src/kandelo-deps/openssl"
REPRO_FLAGS+=" -fmacro-prefix-map=$OPENSSL_PREFIX=/usr/src/kandelo-deps/openssl"

export LC_ALL=C
export TZ=UTC
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export ZERO_AR_DATE=1

echo "==> Configuring curl for wasm32..."
# curl 8.11.1 has no gettext/NLS configure option. Keep option checking fatal
# so a misspelled or copied option cannot silently make the build host-dependent.
PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$OPENSSL_PREFIX/lib/pkgconfig" \
CPPFLAGS="-I$ZLIB_PREFIX/include -I$OPENSSL_PREFIX/include" \
LDFLAGS="-L$ZLIB_PREFIX/lib -L$OPENSSL_PREFIX/lib" \
wasm32posix-configure \
    --enable-option-checking=fatal \
    --prefix=/usr \
    --disable-dependency-tracking \
    --disable-shared \
    --enable-static \
    --with-openssl="$OPENSSL_PREFIX" \
    --with-zlib="$ZLIB_PREFIX" \
    --without-brotli \
    --without-zstd \
    --without-nghttp2 \
    --without-libidn2 \
    --without-libssh2 \
    --without-librtmp \
    --without-winidn \
    --without-libpsl \
    --disable-ldap \
    --disable-ldaps \
    --disable-rtsp \
    --disable-dict \
    --disable-telnet \
    --disable-tftp \
    --disable-pop3 \
    --disable-imap \
    --disable-smb \
    --disable-smtp \
    --disable-gopher \
    --disable-mqtt \
    --disable-threaded-resolver \
    --disable-manual \
    --disable-docs \
    --disable-ntlm \
    --disable-unix-sockets \
    --without-libgsasl \
    --disable-tls-srp \
    CFLAGS="-O2 -fPIC $REPRO_FLAGS"

echo "==> Building curl..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

mkdir -p "$INSTALL_DIR"

audit_wasm_imports() {
    local wasm_path="$1"
    local label="$2"
    local import_dump declared_import_count wasm_imports parsed_import_count
    local wasm_import required_import allowed candidate
    local unexpected_imports=()
    local allowed_imports=(
        env.__channel_base
        env.memory
        kernel.kernel_apply_fork_fd_actions
        kernel.kernel_argv_read
        kernel.kernel_checkpoint
        kernel.kernel_clear_fork_exec
        kernel.kernel_environ_count
        kernel.kernel_environ_get
        kernel.kernel_execve
        kernel.kernel_exit
        kernel.kernel_get_argc
        kernel.kernel_get_fork_exec_argc
        kernel.kernel_get_fork_exec_argv
        kernel.kernel_get_fork_exec_path
        kernel.kernel_get_secure_exec
        kernel.kernel_is_fork_child
        kernel.kernel_push_argv
    )

    import_dump="$(wasm-objdump -x "$wasm_path")"
    declared_import_count="$(
        sed -n 's/^Import\[\([0-9][0-9]*\)\]:$/\1/p' <<<"$import_dump" | head -n 1
    )"
    wasm_imports="$(
        awk '
            /^Import\[[0-9]+\]:$/ { inside = 1; next }
            inside && /^[[:alpha:]_][[:alnum:]_]*\[/ { exit }
            inside && / <- / { sub(/^.* <- /, ""); print }
        ' <<<"$import_dump"
    )"
    parsed_import_count="$(sed '/^$/d' <<<"$wasm_imports" | wc -l | tr -d ' ')"
    if [ -z "$declared_import_count" ] ||
       [ "$parsed_import_count" -ne "$declared_import_count" ]; then
        echo "ERROR: $label import audit could not account for every import: declared=${declared_import_count:-<missing>} parsed=$parsed_import_count" >&2
        exit 1
    fi

    while IFS= read -r wasm_import; do
        [ -n "$wasm_import" ] || continue
        allowed=0
        for candidate in "${allowed_imports[@]}"; do
            if [ "$wasm_import" = "$candidate" ]; then
                allowed=1
                break
            fi
        done
        if [ "$allowed" -eq 0 ]; then
            unexpected_imports+=("$wasm_import")
        fi
    done <<<"$wasm_imports"
    for required_import in env.__channel_base env.memory; do
        if ! grep -Fxq "$required_import" <<<"$wasm_imports"; then
            echo "ERROR: $label is missing required import: $required_import" >&2
            exit 1
        fi
    done
    if [ "${#unexpected_imports[@]}" -ne 0 ]; then
        echo "ERROR: $label has unexpected imports:" >&2
        printf '%s\n' "${unexpected_imports[@]}" >&2
        exit 1
    fi
    echo "==> Validated $label import closure ($declared_import_count imports)"
}

if [ "$RESOLVER_MODE" = "1" ]; then
    case "$PACKAGE_NAME" in
        libcurl)
            make install DESTDIR="$STAGE_DIR"
            mkdir -p "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include"
            cp "$STAGE_DIR/usr/lib/libcurl.a" "$INSTALL_DIR/lib/"
            cp -R "$STAGE_DIR/usr/include/curl" "$INSTALL_DIR/include/"

            # Keep pkg-config metadata relocatable and dependency-complete.
            # PHP's configure reads the two custom variables as well as the
            # normal static link flags.
            supported_protocols="$(sed -n 's/^supported_protocols=//p' "$STAGE_DIR/usr/lib/pkgconfig/libcurl.pc")"
            supported_features="$(sed -n 's/^supported_features=//p' "$STAGE_DIR/usr/lib/pkgconfig/libcurl.pc")"
            cat > "$INSTALL_DIR/lib/pkgconfig/libcurl.pc" <<PCEOF
prefix=\${pcfiledir}/../..
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include
supported_protocols=$supported_protocols
supported_features=$supported_features

Name: libcurl
URL: https://curl.se/
Description: Library to transfer files with URLs
Version: $CURL_VERSION
Requires.private: openssl zlib
Libs: -L\${libdir} -lcurl
Libs.private: -ldl
Cflags: -I\${includedir} -DCURL_STATICLIB
PCEOF

            EXPECTED_OUTPUTS=(
                lib/libcurl.a
                lib/pkgconfig/libcurl.pc
                include/curl/curl.h
                include/curl/curlver.h
                include/curl/easy.h
                include/curl/header.h
                include/curl/mprintf.h
                include/curl/multi.h
                include/curl/options.h
                include/curl/stdcheaders.h
                include/curl/system.h
                include/curl/typecheck-gcc.h
                include/curl/urlapi.h
                include/curl/websockets.h
            )
            output_files=()
            for relative in "${EXPECTED_OUTPUTS[@]}"; do
                if [ ! -s "$INSTALL_DIR/$relative" ]; then
                    echo "ERROR: libcurl declared output is missing or empty: $relative" >&2
                    exit 1
                fi
                output_files+=("$INSTALL_DIR/$relative")
            done
            actual_count="$(find "$INSTALL_DIR" -type f | wc -l | tr -d ' ')"
            if [ "$actual_count" != "${#EXPECTED_OUTPUTS[@]}" ]; then
                echo "ERROR: libcurl staged $actual_count files; expected only ${#EXPECTED_OUTPUTS[@]} declared outputs" >&2
                find "$INSTALL_DIR" -type f -print >&2
                exit 1
            fi

            symbols="$("$NM" "$INSTALL_DIR/lib/libcurl.a" 2>/dev/null)"
            REQUIRED_LIBCURL_SYMBOLS=(
                curl_easy_init
                curl_easy_cleanup
                curl_easy_perform
                curl_version
                curl_version_info
                curl_multi_init
                curl_share_init
            )
            for required_symbol in "${REQUIRED_LIBCURL_SYMBOLS[@]}"; do
                if ! grep -q " T ${required_symbol}\$" <<<"$symbols"; then
                    echo "ERROR: libcurl.a does not export $required_symbol" >&2
                    exit 1
                fi
            done

            # Pull every archive member into a real Kandelo executable. This
            # makes non-PIC objects and otherwise-unused unresolved references
            # visible before PHP absorbs libcurl.a into curl.so.
            SMOKE_SOURCE="$WORK_DIR/libcurl-smoke.c"
            SMOKE_WASM="$WORK_DIR/libcurl-smoke.wasm"
            SMOKE_MEMBER_DIR="$WORK_DIR/libcurl-smoke-members"
            cat > "$SMOKE_SOURCE" <<'EOF'
#include <curl/curl.h>

int main(void) {
    CURL *handle = curl_easy_init();
    if (handle == NULL) {
        return 1;
    }
    curl_easy_cleanup(handle);
    return curl_version_info(CURLVERSION_NOW) == NULL ? 2 : 0;
}
EOF
            mkdir -p "$SMOKE_MEMBER_DIR"
            (
                cd "$SMOKE_MEMBER_DIR"
                "$AR" x "$INSTALL_DIR/lib/libcurl.a"
            )
            archive_member_count="$("$AR" t "$INSTALL_DIR/lib/libcurl.a" | wc -l | tr -d ' ')"
            member_objects=()
            while IFS= read -r member; do
                member_objects+=("$member")
            done < <(find "$SMOKE_MEMBER_DIR" -type f -print | LC_ALL=C sort)
            if [ "$archive_member_count" -eq 0 ] ||
               [ "${#member_objects[@]}" -ne "$archive_member_count" ]; then
                echo "ERROR: failed to extract every libcurl archive member: archive=$archive_member_count extracted=${#member_objects[@]}" >&2
                exit 1
            fi
            "$CC" -O2 \
                -I"$INSTALL_DIR/include" \
                "$SMOKE_SOURCE" \
                -Wl,--no-gc-sections \
                "${member_objects[@]}" \
                "$ZLIB_PREFIX/lib/libz.a" \
                "$OPENSSL_PREFIX/lib/libssl.a" \
                "$OPENSSL_PREFIX/lib/libcrypto.a" \
                -ldl \
                -o "$SMOKE_WASM"
            audit_wasm_imports "$SMOKE_WASM" "libcurl full-member smoke Wasm"

            for forbidden in "$WORK_DIR" "$REPO_ROOT" "$ZLIB_PREFIX" "$OPENSSL_PREFIX" "$INSTALL_DIR"; do
                if grep -aFq "$forbidden" "${output_files[@]}"; then
                    echo "ERROR: libcurl output contains producer path: $forbidden" >&2
                    exit 1
                fi
            done
            echo "==> Validated $archive_member_count libcurl members and ${#EXPECTED_OUTPUTS[@]} exact outputs"
            ;;
        curl)
            cp src/curl "$INSTALL_DIR/curl.wasm"
            chmod 0755 "$INSTALL_DIR/curl.wasm"
            if [ ! -s "$INSTALL_DIR/curl.wasm" ] ||
               [ "$(find "$INSTALL_DIR" -type f | wc -l | tr -d ' ')" -ne 1 ]; then
                echo "ERROR: curl package must contain only non-empty curl.wasm" >&2
                find "$INSTALL_DIR" -type f -print >&2
                exit 1
            fi
            audit_wasm_imports "$INSTALL_DIR/curl.wasm" "curl CLI Wasm"
            for forbidden in "$WORK_DIR" "$REPO_ROOT" "$ZLIB_PREFIX" "$OPENSSL_PREFIX" "$INSTALL_DIR"; do
                if grep -aFq "$forbidden" "$INSTALL_DIR/curl.wasm"; then
                    echo "ERROR: curl.wasm contains producer path: $forbidden" >&2
                    exit 1
                fi
            done
            ;;
        *)
            echo "ERROR: unsupported resolver package name: $PACKAGE_NAME" >&2
            exit 1
            ;;
    esac
else
    cp src/curl "$INSTALL_DIR/curl.wasm"
    chmod 0755 "$INSTALL_DIR/curl.wasm"
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary curl "$INSTALL_DIR/curl.wasm"
fi

    echo "==> $PACKAGE_NAME outputs installed at $INSTALL_DIR"
    find "$INSTALL_DIR" -type f -exec shasum -a 256 {} +
