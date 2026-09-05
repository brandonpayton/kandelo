#!/usr/bin/env bash
set -euo pipefail

# Build Erlang/OTP BEAM VM for wasm32-posix-kernel.
#
# Cross-compilation uses the declared same-release host Erlang/OTP for native
# generators and the wasm32posix SDK toolchain for target artifacts.
#
# Requires: host Erlang/OTP 28 in PATH (provided by scripts/dev-shell.sh).
#
# Outputs: erlang.wasm plus a trimmed, relocatable OTP runtime archive.
# Resolver and package callers own both the work and output directories.

OTP_VERSION="${WASM_POSIX_DEP_VERSION:-${OTP_VERSION:-28.2}}"
OTP_TAG="OTP-${OTP_VERSION}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:-https://github.com/erlang/otp/archive/refs/tags/${OTP_TAG}.tar.gz}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:-b984f9e02bb61637997a35daa9070ae8f41cea1667676416438c467fda3d141f}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"

if [ "$TARGET_ARCH" != "wasm32" ]; then
    echo "ERROR: Erlang/OTP currently supports only wasm32, got: $TARGET_ARCH" >&2
    exit 1
fi
if ! [[ "$SOURCE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: WASM_POSIX_DEP_SOURCE_SHA256 must be an exact lowercase sha256" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR}"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR}"
ARTIFACT_DIR="$WORK_DIR/package-artifacts"
SRC_DIR="$WORK_DIR/erlang-src"
SOURCE_MARKER="$SRC_DIR/.kandelo-erlang-source"
HOST_BOOTSTRAP_ROOT="$WORK_DIR/erlang-host-path"
INSTALL_DIR="$WORK_DIR/erlang-install"
DOWNLOAD_DIR="$WORK_DIR/downloads"
SOURCE_ARCHIVE="$DOWNLOAD_DIR/otp-${OTP_VERSION}.tar.gz"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
CONFIG_SITE="$WORK_DIR/config.site-wasm32-posix"

mkdir -p "$WORK_DIR" "$OUT_DIR" "$ARTIFACT_DIR" "$DOWNLOAD_DIR"

# Use the worktree-local SDK. A sealed publisher exposes the checkout and
# sysroot read-only; every generated source, log, install tree, and package
# output remains below the caller-owned work/output roots above.
# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$SYSROOT"

NPROC="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"
PACKAGE_TAR=tar
if command -v gtar >/dev/null 2>&1; then
    PACKAGE_TAR=gtar
fi
PACKAGE_TAR_VERSION=$("$PACKAGE_TAR" --version 2>/dev/null | sed -n '1p')
if [[ "$PACKAGE_TAR_VERSION" != *"GNU tar"* ]]; then
    echo "ERROR: Erlang packaging requires GNU tar for deterministic archives" >&2
    exit 1
fi

# --- Verify prerequisites ---
if [ ! -f "$SYSROOT/lib/libc.a" ]; then
    echo "ERROR: sysroot not found. Run: bash build.sh" >&2
    exit 1
fi

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found after sourcing sdk/activate.sh." >&2
    exit 1
fi

if ! command -v erl &>/dev/null || ! command -v erlc &>/dev/null; then
    echo "ERROR: host Erlang erl/erlc not found. Run through scripts/dev-shell.sh." >&2
    exit 1
fi

# Verify host Erlang is OTP 28
HOST_OTP_REL=$(erl -boot start_clean \
    -eval 'io:format("~s", [erlang:system_info(otp_release)]), halt().' \
    -noshell -noinput)
if [ "$HOST_OTP_REL" != "28" ]; then
    echo "ERROR: Host Erlang is OTP $HOST_OTP_REL, need OTP 28" >&2
    exit 1
fi

echo "==> Host Erlang: OTP $HOST_OTP_REL ($(erl -boot start_clean -eval 'io:format("~s", [erlang:system_info(version)]), halt().' -noshell -noinput))"

# --- Download and verify the exact declared OTP source ---
EXPECTED_SOURCE_MARKER="${OTP_VERSION} ${SOURCE_URL} ${SOURCE_SHA256}"
if [ -d "$SRC_DIR" ] && [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$EXPECTED_SOURCE_MARKER" ]; then
    echo "==> Existing OTP source does not match the declared identity; replacing it..."
    rm -rf "$SRC_DIR" "$HOST_BOOTSTRAP_ROOT" "$INSTALL_DIR"
fi
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Downloading Erlang/OTP ${OTP_VERSION}..."
    rm -f "$SOURCE_ARCHIVE"
    curl --retry 10 --retry-delay 5 --retry-max-time 300 --retry-all-errors \
        -fsSL "$SOURCE_URL" -o "$SOURCE_ARCHIVE"
    echo "$SOURCE_SHA256  $SOURCE_ARCHIVE" | shasum -a 256 -c -
    mkdir -p "$SRC_DIR"
    tar xzf "$SOURCE_ARCHIVE" -C "$SRC_DIR" --strip-components=1
    printf '%s\n' "$EXPECTED_SOURCE_MARKER" > "$SOURCE_MARKER"
    echo "==> Source extracted to $SRC_DIR"
else
    # Reused caller-owned work roots still revalidate the cached source bytes.
    if [ -f "$SOURCE_ARCHIVE" ]; then
        echo "$SOURCE_SHA256  $SOURCE_ARCHIVE" | shasum -a 256 -c -
    fi
fi

export ERL_TOP="$SRC_DIR"

# Autoconf must be told both sides of the cross build. Derive the build
# machine from OTP's own config.guess instead of baking in a runner-specific
# Darwin or Linux triple. Without --build, configure can classify Kandelo's
# permissively linked Wasm test executable as native and later try to execute
# target-only build helpers such as yielding_c_fun on the publisher host.
BUILD_TRIPLE="$("$SRC_DIR/make/autoconf/config.guess")"

# OTP's documented cross-build path supports a compatible same-release OTP in
# PATH. Keep BOOTSTRAP_ROOT's prepended bin directory intentionally empty so
# OTP finds the declared dev-shell erl/erlc. Copying an in-tree bootstrap does
# not work: its launchers embed the original ROOTDIR and BINDIR, which the
# target clean/configure transition removes.
rm -rf "$HOST_BOOTSTRAP_ROOT"
mkdir -p "$HOST_BOOTSTRAP_ROOT/bootstrap/bin"

# --- Phase 2: Create config.site for cross-compilation ---
# Keep the generated configure cache under the caller-owned work root. The
# checked-in file documents the same answers but remains an immutable recipe.
cat > "$CONFIG_SITE" << 'SITE_EOF'
# config.site for Erlang/OTP cross-compilation to wasm32-posix
#
# Our linker uses --allow-undefined, so ALL link-based function detection
# passes. We must explicitly override what we don't have.

# --- Basic types ---
ac_cv_sizeof_int=4
ac_cv_sizeof_long=4
ac_cv_sizeof_long_long=8
ac_cv_sizeof_void_p=4
ac_cv_sizeof_short=2
ac_cv_sizeof_float=4
ac_cv_sizeof_double=8
ac_cv_sizeof_size_t=4
ac_cv_sizeof_off_t=8
ac_cv_sizeof_time_t=8
ac_cv_sizeof_pid_t=4
ac_cv_sizeof_char=1
ac_cv_sizeof_wchar_t=4

ac_cv_c_bigendian=no

# --- Functions we HAVE ---
ac_cv_func_clock_gettime=yes
ac_cv_func_clock_getres=yes
ac_cv_func_mmap=yes
ac_cv_func_munmap=yes
ac_cv_func_poll=yes
ac_cv_func_select=yes
ac_cv_func_pipe=yes
ac_cv_func_pipe2=yes
ac_cv_func_fork=yes
ac_cv_func_socketpair=yes
ac_cv_func_socket=yes
ac_cv_func_bind=yes
ac_cv_func_listen=yes
ac_cv_func_accept=yes
ac_cv_func_connect=yes
ac_cv_func_getsockopt=yes
ac_cv_func_setsockopt=yes
ac_cv_func_getsockname=yes
ac_cv_func_getpeername=yes
ac_cv_func_recvfrom=yes
ac_cv_func_sendto=yes
ac_cv_func_shutdown=yes
ac_cv_func_kill=yes
ac_cv_func_sigaction=yes
ac_cv_func_sigprocmask=yes
ac_cv_func_sigtimedwait=yes
ac_cv_func_nanosleep=yes
ac_cv_func_usleep=yes
ac_cv_func_getcwd=yes
ac_cv_func_chdir=yes
ac_cv_func_fchdir=yes
ac_cv_func_mkdir=yes
ac_cv_func_rmdir=yes
ac_cv_func_unlink=yes
ac_cv_func_rename=yes
ac_cv_func_symlink=yes
ac_cv_func_readlink=yes
ac_cv_func_stat=yes
ac_cv_func_fstat=yes
ac_cv_func_lstat=yes
ac_cv_func_access=yes
ac_cv_func_umask=yes
ac_cv_func_dup=yes
ac_cv_func_dup2=yes
ac_cv_func_fcntl=yes
ac_cv_func_ftruncate=yes
ac_cv_func_lseek=yes
ac_cv_func_getpid=yes
ac_cv_func_getppid=yes
ac_cv_func_getuid=yes
ac_cv_func_geteuid=yes
ac_cv_func_getgid=yes
ac_cv_func_getegid=yes
ac_cv_func_waitpid=yes
ac_cv_func_alarm=yes
ac_cv_func_setitimer=yes
ac_cv_func_getitimer=yes
ac_cv_func_gethostname=yes
ac_cv_func_inet_pton=yes
ac_cv_func_strerror=yes
ac_cv_func_strerror_r=yes
ac_cv_func_posix_memalign=yes
ac_cv_func_openat=yes
ac_cv_func_fstatat=yes
ac_cv_func_readlinkat=yes
ac_cv_func_renameat=yes
ac_cv_func_unlinkat=yes
ac_cv_func_mkdirat=yes
ac_cv_func_eventfd=yes
ac_cv_func_getaddrinfo=yes
ac_cv_func_gethostbyname=yes

# --- pthreads ---
ac_cv_pthread=yes
ac_cv_func_pthread_create=yes
ac_cv_func_pthread_mutex_lock=yes
ac_cv_func_pthread_cond_wait=yes
ac_cv_func_pthread_rwlock_rdlock=yes
ac_cv_func_pthread_spin_lock=yes
ac_cv_func_pthread_attr_setguardsize=yes

# --- Functions we DON'T have ---
ac_cv_func_epoll_create=no
ac_cv_func_epoll_create1=no
ac_cv_func_epoll_ctl=no
ac_cv_func_kqueue=no
ac_cv_func_mprotect=no
ac_cv_func_mremap=no
ac_cv_func_madvise=no
ac_cv_func_mlockall=no
ac_cv_func_getrlimit=no
ac_cv_func_setrlimit=no
ac_cv_func_sched_setaffinity=no
ac_cv_func_sched_getaffinity=no
ac_cv_func_sched_yield=yes
ac_cv_func_dlopen=yes
ac_cv_func_dlsym=yes
ac_cv_func_dlclose=yes
ac_cv_func_sendfile=no
ac_cv_func_writev=yes
ac_cv_func_readv=yes
ac_cv_func_pread=yes
ac_cv_func_pwrite=yes
ac_cv_func_preadv=yes
ac_cv_func_pwritev=yes
ac_cv_func_getrusage=no
ac_cv_func_setuid=no
ac_cv_func_setgid=no
ac_cv_func_seteuid=no
ac_cv_func_setegid=no
ac_cv_func_setreuid=no
ac_cv_func_setregid=no
ac_cv_func_getpwuid=no
ac_cv_func_getpwnam=no
ac_cv_func_getgrnam=no
ac_cv_func_getgrgid=no
ac_cv_func_endpwent=no
ac_cv_func_getpwent=no
ac_cv_func_chown=no
ac_cv_func_fchown=no
ac_cv_func_lchown=no
ac_cv_func_chroot=no
ac_cv_func_prctl=no
ac_cv_func_syslog=no
ac_cv_func_openlog=no
ac_cv_func_closelog=no
ac_cv_func_getentropy=no
ac_cv_func_getrandom=no
ac_cv_func_memfd_create=no
ac_cv_func_close_range=no
ac_cv_func_fdatasync=no
ac_cv_func_sync=no
ac_cv_func_inotify_init=no
ac_cv_func_inotify_init1=no
ac_cv_func_timerfd_create=no
ac_cv_func_signalfd=no
ac_cv_func_accept4=yes
ac_cv_func_getifaddrs=no
ac_cv_func_freeifaddrs=no
ac_cv_func_if_nametoindex=no

# --- Headers we don't have ---
ac_cv_header_sys_epoll_h=no
ac_cv_header_sys_event_h=no
ac_cv_header_sys_timerfd_h=no
ac_cv_header_sys_signalfd_h=no
ac_cv_header_sys_inotify_h=no
ac_cv_header_sys_resource_h=no
ac_cv_header_sys_sysctl_h=no
ac_cv_header_sys_sendfile_h=no
ac_cv_header_syslog_h=no
ac_cv_header_utmp_h=no
ac_cv_header_shadow_h=no
ac_cv_header_net_if_h=yes
ac_cv_header_netinet_in_h=yes
ac_cv_header_arpa_inet_h=yes
ac_cv_header_sys_un_h=yes
ac_cv_header_poll_h=yes
ac_cv_header_dlfcn_h=yes

# BEAM-specific
ac_cv_func_strlcpy=no
ac_cv_func_strlcat=no
ac_cv_func_mallopt=no
ac_cv_header_malloc_h=no

# Disable sctp
ac_cv_header_netinet_sctp_h=no
SITE_EOF

echo "==> Created config.site: $CONFIG_SITE"

# --- Phase 3: Cross-compile ERTS for wasm32-posix ---
echo "==> Phase 3: Cross-compiling Erlang/OTP for wasm32-posix..."
cd "$SRC_DIR"

# Clean target outputs while preserving the separately saved bootstrap tree.
# MAKE_CLEAN is a recursive clean policy, not a make target; invoking make
# with only that assignment silently rebuilds the previous configuration and
# can retain stale objects across recipe/flag changes.
make clean MAKE_CLEAN=clean >"$WORK_DIR/clean.log" 2>&1 || true
# OTP source releases carry precompiled preloaded BEAM modules, and the top
# clean target intentionally preserves them. They contain the release
# producer's absolute source paths and would bypass this build's deterministic
# compiler setting, so remove their exact output directory before configure.
# The recursive clean target cannot run yet because configure owns the
# host-triple otp.mk file that its Makefile includes.
rm -rf "$SRC_DIR/erts/preloaded/ebin"
rm -rf "$INSTALL_DIR" "$ARTIFACT_DIR"
mkdir -p "$INSTALL_DIR" "$ARTIFACT_DIR"

# The key: OTP's cross-compilation needs --host to be a recognized config.sub triplet.
# wasm32-unknown-wasi is recognized and closest to our platform.
CONFIG_SITE="$CONFIG_SITE" \
CC="wasm32posix-cc" \
CXX="wasm32posix-c++" \
AR="wasm32posix-ar" \
RANLIB="wasm32posix-ranlib" \
LD="wasm32posix-cc" \
LDFLAGS="-Wl,--allow-multiple-definition" \
CFLAGS="-O2 -DNO_JUMP_TABLE -fno-stack-protector -D__linux__ -D_GNU_SOURCE \
    -ffile-prefix-map=$SRC_DIR=/usr/src/erlang-otp-$OTP_VERSION \
    -fdebug-prefix-map=$SRC_DIR=/usr/src/erlang-otp-$OTP_VERSION \
    -fmacro-prefix-map=$SRC_DIR=/usr/src/erlang-otp-$OTP_VERSION" \
LIBS="" \
./configure \
    --build="$BUILD_TRIPLE" \
    --host=wasm32-unknown-wasi \
    --disable-jit \
    --disable-hipe \
    --without-termcap \
    --without-wx \
    --without-odbc \
    --without-ssl \
    --without-crypto \
    --without-ssh \
    --without-megaco \
    --without-diameter \
    --without-snmp \
    --without-ftp \
    --without-tftp \
    --without-observer \
    --without-debugger \
    --without-dialyzer \
    --without-jinterface \
    --without-et \
    --without-eldap \
    --without-common_test \
    --without-eunit \
    --without-tools \
    --without-runtime_tools \
    --without-reltool \
    --without-xmerl \
    --without-mnesia \
    --without-os_mon \
    --without-public_key \
    --without-asn1 \
    --disable-kernel-poll \
    --disable-sctp \
    --disable-sharing-preserving \
    --enable-deterministic-build \
    --prefix="$INSTALL_DIR" \
    erl_xcomp_sysroot="$SYSROOT" \
    erl_xcomp_bigendian=no \
    erl_xcomp_poll=yes \
    erl_xcomp_kqueue=no \
    erl_xcomp_clock_gettime_cpu_time=no \
    erl_xcomp_getaddrinfo=yes \
    erl_xcomp_linux_nptl=yes \
    erl_xcomp_linux_usable_sigaltstack=yes \
    erl_xcomp_linux_usable_sigusrx=yes \
    erl_xcomp_putenv_copy=no \
    erl_xcomp_reliable_fpe=no \
    erl_xcomp_dlsym_brk_wrappers=no \
    erl_xcomp_posix_memalign=yes \
    erl_xcomp_after_morecore_hook=no \
    erl_xcomp_code_model_small=no \
    2>&1 | tee "$WORK_DIR/configure.log" | tail -50

# Configure owns the target otp.mk consumed by this sub-build, so only now can
# the source release's removed preloaded modules be regenerated deterministically
# with the verified host OTP. The opt target writes them to erts/ebin; OTP's
# copy target strips and installs that exact set into erts/preloaded/ebin, where
# the target emulator build reads them. Keep these as separate make processes:
# Package builds supply parallel MAKEFLAGS, and independent goals in one process
# would otherwise allow copy to race the module compilation.
mkdir -p "$SRC_DIR/erts/preloaded/ebin"
make -C "$SRC_DIR/erts/preloaded/src" \
    OVERRIDE_TARGET=wasm32-unknown-wasi opt
make -C "$SRC_DIR/erts/preloaded/src" \
    OVERRIDE_TARGET=wasm32-unknown-wasi copy

echo "==> Configure complete. Patching config.h files..."

# Post-configure: fix false positives from --allow-undefined linker
# Our linker passes all link tests, so configure enables many functions
# that don't actually exist in our musl sysroot.
patch_config_h() {
    local config_h="$1"
    [ -f "$config_h" ] || return 0

    python3 -c "
import re, sys
with open('$config_h', 'r') as f:
    content = f.read()

# Functions/features to force-disable (false positives from --allow-undefined)
disable = {
    # brk/sbrk GNU variants
    'HAVE___BRK', 'HAVE___SBRK', 'HAVE__BRK', 'HAVE__SBRK',
    'HAVE_BRK', 'HAVE_SBRK', 'HAVE__END_SYMBOL', 'HAVE_END_SYMBOL',
    # Solaris-specific
    'HAVE_CLOCK_GET_ATTRIBUTES', 'HAVE_GETHRTIME', 'HAVE_GETHRVTIME',
    'HAVE_IEEE_HANDLER', 'HAVE_FPSETMASK',
    # GNU extensions not in musl
    'HAVE_DLVSYM', 'HAVE_FWRITE_UNLOCKED', 'HAVE_CLOSEFROM',
    'HAVE_CONFLICTING_FREAD_DECLARATION',
    # Linux-specific not in our kernel
    'HAVE_CLOCK_GETTIME_MONOTONIC_RAW', 'HAVE_SETNS',
    'HAVE_NETPACKET_PACKET_H', 'HAVE_SO_BSDCOMPAT',
    'HAVE_SCHED_xETAFFINITY',
    # Network functions not in our musl
    'HAVE_GETHOSTBYNAME2', 'HAVE_GETIPNODEBYADDR', 'HAVE_GETIPNODEBYNAME',
    'HAVE_GETPROTOENT', 'HAVE_ENDPROTOENT', 'HAVE_SETPROTOENT',
    'HAVE_RES_GETHOSTBYNAME',
    # Interface functions not in our musl
    'HAVE_IF_FREENAMEINDEX', 'HAVE_IF_INDEXTONAME', 'HAVE_IF_NAMEINDEX',
    'HAVE_IFADDRS_H',
    # PTY/terminal not through standard APIs
    'HAVE_OPENPTY', 'HAVE_WORKING_POSIX_OPENPT', 'HAVE_PTY_H',
    # Memory functions not in our kernel
    'HAVE_POSIX_FADVISE', 'HAVE_POSIX_MADVISE',
    # Time functions not in our musl
    'HAVE_POSIX2TIME', 'HAVE_TIME2POSIX', 'HAVE_PPOLL',
    # Misc not available
    'HAVE_ELF_H', 'HAVE_LIBUTIL', 'HAVE_VSYSLOG',
    'HAVE_SYS_STROPTS_H', 'HAVE_MALLOPT',
    # Struct members that don't exist
    'HAVE_STRUCT_IFREQ_IFR_HWADDR', 'HAVE_STRUCT_IFREQ_IFR_IFINDEX',
    'HAVE_STRUCT_IFREQ_IFR_MAP',
}

count = 0
for name in disable:
    pattern = rf'^#define {name}\b.*$'
    new = f'/* #undef {name} */'
    content, n = re.subn(pattern, new, content, flags=re.MULTILINE)
    count += n

with open('$config_h', 'w') as f:
    f.write(content)
print(f'Patched {count} defines in $config_h')
"
}

# Patch all config.h files generated by configure
while IFS= read -r -d '' ch; do
    patch_config_h "$ch"
done < <(find "$SRC_DIR" -path "*/wasm32-unknown-wasi/config.h" -print0 2>/dev/null)
# Also patch the main ERTS config.h
ERTS_CONFIG="$SRC_DIR/erts/wasm32-unknown-wasi/config.h"
patch_config_h "$ERTS_CONFIG"

# OTP deliberately records its complete compiler command line in config.h so
# flag changes rebuild the emulator. That raw value includes the randomized
# caller work root through generated -I flags. Preserve the rebuild sentinel
# while replacing its user-visible diagnostic value with a stable identity;
# the bottle must not retain a runner path.
python3 - "$ERTS_CONFIG" "$OTP_VERSION" <<'PY'
import re
import sys

path, version = sys.argv[1:]
content = open(path, "r", encoding="utf-8").read()
replacement = (
    '#define ERTS_EMU_CMDLINE_FLAGS '
    f'"Kandelo Erlang/OTP {version} wasm32 release build"'
)
content, count = re.subn(
    r'^#define ERTS_EMU_CMDLINE_FLAGS .+$',
    replacement,
    content,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit("ERTS_EMU_CMDLINE_FLAGS definition was not generated exactly once")
open(path, "w", encoding="utf-8").write(content)
PY

# `erlang:system_info(compile_info)` embeds a generated copy of the literal
# compiler/linker command lines. The prefix-map flags necessarily name this
# invocation's private source root, even though Clang correctly rewrites all
# compiled source/debug paths. Normalize only that user-facing build metadata
# to a stable, truthful release description; actual CFLAGS in the Makefile are
# unchanged and continue to drive compilation.
EMU_MAKEFILE="$SRC_DIR/erts/emulator/wasm32-unknown-wasi/Makefile"
python3 - "$EMU_MAKEFILE" "$OTP_VERSION" <<'PY'
import sys

path, version = sys.argv[1:]
content = open(path, "r", encoding="utf-8").read()
old = '-v CFLAGS "$(CFLAGS)" -v LDFLAGS "$(LDFLAGS)"'
new = (
    f'-v CFLAGS "Kandelo Erlang/OTP {version} wasm32 -O2 deterministic release" '
    '-v LDFLAGS "Kandelo wasm32 release linker"'
)
count = content.count(old)
if count != 2:
    raise SystemExit(f"expected two OTP compile-info generator invocations, found {count}")
open(path, "w", encoding="utf-8").write(content.replace(old, new))
PY

# Patch run_erl.c: LOG_ERR is NULL when syslog disabled, needs to be int
RUN_ERL="$SRC_DIR/erts/etc/unix/run_erl.c"
if grep -q '#    define LOG_ERR NULL' "$RUN_ERL" 2>/dev/null; then
    sed -i.bak 's/#    define LOG_ERR NULL/#    define LOG_ERR 3/' "$RUN_ERL"
    sed -i.bak 's/#    define LOG_WARNING NULL/#    define LOG_WARNING 4/' "$RUN_ERL"
    sed -i.bak 's/#    define LOG_INFO NULL/#    define LOG_INFO 6/' "$RUN_ERL"
    echo "==> Patched run_erl.c syslog defines"
fi

# Patch epmd.c: closelog() called unconditionally but we don't have syslog
EPMD_C="$SRC_DIR/erts/epmd/src/epmd.c"
if grep -q '    closelog();' "$EPMD_C" 2>/dev/null && ! grep -q 'HAVE_SYSLOG_H.*closelog' "$EPMD_C" 2>/dev/null; then
    sed -i.bak 's/    closelog();/#ifdef HAVE_SYSLOG_H\n    closelog();\n#endif/' "$EPMD_C"
    echo "==> Patched epmd.c closelog"
fi

# Patch global.h: ESTACK/WSTACK explicit field initialization on wasm32.
# LLVM's wasm32 backend miscompiles aggregate initialization of structs
# containing pointers to shadow-stack local arrays at -O2. This is a compiler
# portability boundary: the replacement performs the same field assignments
# explicitly and does not change Kandelo syscall or POSIX behavior.
GLOBAL_H="$SRC_DIR/erts/emulator/beam/global.h"
if ! grep -q 'estack_make_default_' "$GLOBAL_H" 2>/dev/null; then
    python3 "$SCRIPT_DIR/patches/patch-global-h.py" "$GLOBAL_H"
    echo "==> Patched global.h ESTACK/WSTACK for wasm32"
fi

# Patch inet_drv.c and ram_file_drv.c: driver start function signatures.
# erts_open_driver() calls driver->start via call_indirect with 3 args
# (port, command, opts), but these drivers define start with only 2 args.
# On native platforms the extra arg is harmlessly ignored, but wasm's
# call_indirect validates the function type and traps on mismatch.
# Fix: add a third void* parameter and cast in struct initializers.
INET_DRV="$SRC_DIR/erts/emulator/drivers/common/inet_drv.c"
if grep -q 'tcp_inet_start(ErlDrvPort, char\* command);' "$INET_DRV" 2>/dev/null; then
    # Fix forward declarations (add 3rd param)
    sed -i.bak \
        's/static ErlDrvData tcp_inet_start(ErlDrvPort, char\* command);/static ErlDrvData tcp_inet_start(ErlDrvPort, char* command, void*);/' \
        "$INET_DRV"
    sed -i.bak \
        's/static ErlDrvData udp_inet_start(ErlDrvPort, char\* command);/static ErlDrvData udp_inet_start(ErlDrvPort, char* command, void*);/' \
        "$INET_DRV"
    # Fix definitions (add 3rd param)
    sed -i.bak \
        's/static ErlDrvData tcp_inet_start(ErlDrvPort port, char\* args)$/static ErlDrvData tcp_inet_start(ErlDrvPort port, char* args, void* _opts)/' \
        "$INET_DRV"
    sed -i.bak \
        's/static ErlDrvData udp_inet_start(ErlDrvPort port, char \*args)$/static ErlDrvData udp_inet_start(ErlDrvPort port, char *args, void* _opts)/' \
        "$INET_DRV"
    # Cast function pointers in struct initializers to match 2-arg typedef
    sed -i.bak \
        's/    tcp_inet_start,/    (ErlDrvData (*)(ErlDrvPort, char*)) tcp_inet_start,/' \
        "$INET_DRV"
    sed -i.bak \
        's/    udp_inet_start,/    (ErlDrvData (*)(ErlDrvPort, char*)) udp_inet_start,/' \
        "$INET_DRV"
    echo "==> Patched inet_drv.c driver start signatures (3-arg for wasm call_indirect)"
fi

RAM_FILE_DRV="$SRC_DIR/erts/emulator/drivers/common/ram_file_drv.c"
if grep -q 'rfile_start(ErlDrvPort, char\*);' "$RAM_FILE_DRV" 2>/dev/null; then
    # Fix declaration and definition (add 3rd param)
    sed -i.bak \
        's/static ErlDrvData rfile_start(ErlDrvPort, char\*);/static ErlDrvData rfile_start(ErlDrvPort, char*, void*);/' \
        "$RAM_FILE_DRV"
    sed -i.bak \
        's/static ErlDrvData rfile_start(ErlDrvPort port, char\* buf)$/static ErlDrvData rfile_start(ErlDrvPort port, char* buf, void* _opts)/' \
        "$RAM_FILE_DRV"
    # Cast function pointers in struct initializer and dynamic assignment
    sed -i.bak \
        's/    rfile_start,$/    (ErlDrvData (*)(ErlDrvPort, char*)) rfile_start,/' \
        "$RAM_FILE_DRV"
    sed -i.bak \
        's/\.start = rfile_start;/.start = (ErlDrvData (*)(ErlDrvPort, char*)) rfile_start;/' \
        "$RAM_FILE_DRV"
    echo "==> Patched ram_file_drv.c driver start signature (3-arg for wasm call_indirect)"
fi

# Patch Makefile: compile certain files at -O1.
# LLVM's wasm32 backend miscompiles several BEAM files at -O2, causing
# shadow-stack pointer corruption and incorrect aggregate initialization. Keep
# this optimizer workaround bounded to the affected translation units; it must
# not turn a runtime memory failure into synthetic success.
if [ -f "$EMU_MAKEFILE" ] && ! grep -q 'erl_unicode.o:' "$EMU_MAKEFILE"; then
    sed -i.bak '/\$(OBJDIR)\/beam_emu\.o: beam\/emu\/beam_emu\.c/i\
# wasm32: erl_unicode.c miscompiles at -O2 (iodata traversal returns garbage).\
$(OBJDIR)/erl_unicode.o: beam/erl_unicode.c\
	$(V_CC) $(subst -O2,-O1,$(CFLAGS)) $(INCLUDES) -c $< -o $@\
\
# wasm32: erl_db_util.c miscompiles at -O2 (db_is_fully_bound OOB crash).\
$(OBJDIR)/erl_db_util.o: beam/erl_db_util.c\
	$(V_CC) $(subst -O2,-O1,$(CFLAGS)) $(INCLUDES) -c $< -o $@\
\
# wasm32: erl_db_hash.c miscompiles at -O2 (match_traverse corruption).\
$(OBJDIR)/erl_db_hash.o: beam/erl_db_hash.c\
	$(V_CC) $(subst -O2,-O1,$(CFLAGS)) $(INCLUDES) -c $< -o $@\
\
# wasm32: erl_db.c at -O1 for consistent ETS optimization level.\
$(OBJDIR)/erl_db.o: beam/erl_db.c\
	$(V_CC) $(subst -O2,-O1,$(CFLAGS)) $(INCLUDES) -c $< -o $@\

' "$EMU_MAKEFILE"
    echo "==> Patched Makefile: erl_unicode.c, erl_db_util.c, erl_db_hash.c at -O1"
fi

echo "==> Starting build..."

# OTP prepends BOOTSTRAP_ROOT/bootstrap/bin to PATH. It must remain empty so a
# non-relocatable in-tree launcher cannot shadow the verified host OTP.
if find "$HOST_BOOTSTRAP_ROOT/bootstrap/bin" -mindepth 1 -print -quit | grep -q .; then
    echo "ERROR: host OTP bootstrap prefix must remain empty: $HOST_BOOTSTRAP_ROOT" >&2
    exit 1
fi
make -j"$NPROC" BOOTSTRAP_ROOT="$HOST_BOOTSTRAP_ROOT" \
    2>&1 | tee "$WORK_DIR/build.log" | tail -50

echo "==> Build complete. Creating release..."

# Create the release through the same verified host-generator contract.
make release RELEASE_ROOT="$INSTALL_DIR" BOOTSTRAP_ROOT="$HOST_BOOTSTRAP_ROOT" \
    2>&1 | tail -20

# Find the BEAM emulator
BEAM_BIN=$(find "$INSTALL_DIR" -type f \( -name "beam.smp" -o -name "beam" \) -print -quit 2>/dev/null)
if [ -n "$BEAM_BIN" ]; then
    echo "==> Erlang/OTP built successfully!"
    ls -lh "$BEAM_BIN"
    cp "$BEAM_BIN" "$ARTIFACT_DIR/erlang.wasm"
    wasm-strip "$ARTIFACT_DIR/erlang.wasm"
    echo "==> BEAM emulator: $ARTIFACT_DIR/erlang.wasm"
else
    echo "==> Looking for BEAM in build tree..."
    find "$SRC_DIR/bin" "$SRC_DIR/erts" -name "beam*" -type f 2>/dev/null | head -10
    echo "ERROR: BEAM emulator not found after build" >&2
    exit 1
fi

echo "==> Erlang/OTP ${OTP_VERSION} build complete!"
echo "==> Install directory: $INSTALL_DIR"

# Validate and, when the real OTP forker imports fork(), instrument the final
# BEAM module through Kandelo's normal continuation pipeline. The retired
# wasm32 patch that disabled the forker is deliberately not applied.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary erlang "$ARTIFACT_DIR/erlang.wasm"

CURRENT_ABI=$(wasm_current_abi_version "$REPO_ROOT")
prepare_runtime_wasm() {
    local artifact="$1"
    local instrumented
    local artifact_abi

    wasm-strip "$artifact"
    if wasm_imports_migration_seed "$artifact" && ! wasm_has_complete_fork_instrumentation "$artifact"; then
        if wasm_has_any_fork_instrumentation "$artifact"; then
            wasm_require_fork_instrumentation_if_needed "$artifact"
            return 1
        fi
        instrumented=$(mktemp "$WORK_DIR/erlang-fork-instrument.XXXXXX.wasm")
        "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" "$artifact" \
            --checkpoint-entry kernel.kernel_checkpoint -o "$instrumented"
        chmod 0755 "$instrumented"
        mv "$instrumented" "$artifact"
    fi
    wasm_require_no_legacy_asyncify "$artifact"
    wasm_require_fork_instrumentation_if_needed "$artifact"
    artifact_abi=$(wasm_extract_abi_version "$artifact" || true)
    if [ -z "$CURRENT_ABI" ] || [ "$artifact_abi" != "$CURRENT_ABI" ]; then
        echo "ERROR: runtime helper ABI ${artifact_abi:-missing} does not match Kandelo ABI ${CURRENT_ABI:-missing}: $artifact" >&2
        return 1
    fi
}

# Fail before packaging if a compiler diagnostic or debug section retained a
# caller checkout, work root, sysroot, or common CI scratch prefix.
for forbidden in "$WORK_DIR" "$REPO_ROOT" "$SYSROOT" /private/tmp/ /Users/ /home/runner/work/ /home/runner/_work/ /nix/store/; do
    if LC_ALL=C grep -aFq "$forbidden" "$ARTIFACT_DIR/erlang.wasm"; then
        echo "ERROR: erlang.wasm embeds forbidden host path: $forbidden" >&2
        exit 1
    fi
done

# --- Pack the relocatable OTP runtime tree ---
# The packaged runtime and the legacy erlang-vfs image both consume this exact
# output. It carries OTP applications and release boot files; executable ERTS
# helpers are admitted only when they are valid Kandelo Wasm modules.
echo "==> Packing OTP runtime tree (erlang-otp.tar.zst)..."
OTP_STAGE=$(mktemp -d "$WORK_DIR/otp-stage.XXXXXX")
trap 'rm -rf "$OTP_STAGE"' EXIT
OTP_APPS=(
    "lib/kernel-10.4.2"
    "lib/stdlib-7.1"
    "lib/erts-16.1.2"
    "lib/compiler-9.0.3"
)
for app in "${OTP_APPS[@]}"; do
    if [ ! -d "$INSTALL_DIR/$app/ebin" ]; then
        echo "ERROR: expected OTP application ebin not produced: $INSTALL_DIR/$app/ebin" >&2
        exit 1
    fi
    for component in ebin include priv; do
        src="$INSTALL_DIR/$app/$component"
        [ -d "$src" ] || continue
        mkdir -p "$OTP_STAGE/$app"
        cp -R "$src" "$OTP_STAGE/$app/$component"
    done
done
mkdir -p "$OTP_STAGE/releases"
cp -R "$INSTALL_DIR/releases/28" "$OTP_STAGE/releases/28"

# erlexec follows OTP's installed-tree contract and looks for the default boot
# file at $ROOTDIR/bin/start.boot. `make release` leaves the release-specific
# files below releases/28 and expects the final Install step to populate bin/.
# Materialize the minimal (non-SASL) boot selection in the relocatable archive
# without running Install, whose generated host shell launchers are not target
# executables and would bake the private release root into the package.
mkdir -p "$OTP_STAGE/bin"
cp "$INSTALL_DIR/releases/28/start_clean.boot" "$OTP_STAGE/bin/start.boot"
cp "$INSTALL_DIR/releases/28/start_clean.boot" "$OTP_STAGE/bin/start_clean.boot"
cp "$INSTALL_DIR/releases/28/start_clean.script" "$OTP_STAGE/bin/start.script"
cp "$INSTALL_DIR/releases/28/start_clean.script" "$OTP_STAGE/bin/start_clean.script"
cp "$INSTALL_DIR/releases/28/no_dot_erlang.boot" "$OTP_STAGE/bin/no_dot_erlang.boot"

ERTS_RUNTIME_DIR=$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -type d -name 'erts-*' -print -quit)
if [ -z "$ERTS_RUNTIME_DIR" ] || [ ! -d "$ERTS_RUNTIME_DIR/bin" ]; then
    echo "ERROR: OTP release did not produce its ERTS runtime bin directory" >&2
    exit 1
fi
ERTS_RUNTIME_NAME=$(basename "$ERTS_RUNTIME_DIR")
mkdir -p "$OTP_STAGE/$ERTS_RUNTIME_NAME/bin"
while IFS= read -r -d '' helper; do
    if ! wasm_is_binary "$helper"; then
        continue
    fi
    staged="$OTP_STAGE/$ERTS_RUNTIME_NAME/bin/$(basename "$helper")"
    cp "$helper" "$staged"
    chmod 0755 "$staged"
    prepare_runtime_wasm "$staged"
done < <(find "$ERTS_RUNTIME_DIR/bin" -maxdepth 1 -type f -print0)

if [ ! -x "$OTP_STAGE/$ERTS_RUNTIME_NAME/bin/erl_child_setup" ]; then
    echo "ERROR: OTP release did not produce a Kandelo erl_child_setup helper" >&2
    exit 1
fi

while IFS= read -r -d '' runtime_file; do
    for forbidden in "$WORK_DIR" "$REPO_ROOT" "$SYSROOT" /private/tmp/ /Users/ /home/runner/work/ /home/runner/_work/ /nix/store/; do
        if LC_ALL=C grep -aFq "$forbidden" "$runtime_file"; then
            echo "ERROR: OTP runtime file embeds forbidden host path: $runtime_file ($forbidden)" >&2
            exit 1
        fi
    done
done < <(find "$OTP_STAGE" -type f -print0)

OTP_TARBALL="$ARTIFACT_DIR/erlang-otp.tar.zst"
rm -f "$OTP_TARBALL"
"$PACKAGE_TAR" --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    --pax-option=delete=atime,delete=ctime --zstd -cf "$OTP_TARBALL" -C "$OTP_STAGE" .

OTP_SIZE=$(wc -c < "$OTP_TARBALL" | tr -d ' ')
echo "==> erlang-otp.tar.zst: $(echo "$OTP_SIZE" | numfmt --to=iec 2>/dev/null || echo "${OTP_SIZE} bytes")"

install_local_runtime_file erlang "$OTP_TARBALL"

# Direct developer builds historically leave convenient copies beside the
# recipe. Resolver and package callers instead receive the exact same bytes
# through the executable/runtime-file caller-owned output contract above.
if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$ARTIFACT_DIR/erlang.wasm" "$OUT_DIR/erlang.wasm"
    cp "$OTP_TARBALL" "$OUT_DIR/erlang-otp.tar.zst"
fi
