{
  description = "kandelo dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachSystem [
      "aarch64-darwin"
      "x86_64-darwin"
      "x86_64-linux"
      "aarch64-linux"
    ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };

        rustToolchain = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;

        llvmPkg = pkgs.llvmPackages_21;
        llvmVersion = llvmPkg.llvm.version;

        # Combined tree so LLVM_PREFIX/bin contains clang + llvm-* + wasm-ld,
        # and LLVM_PREFIX/include/c++/v1 contains libc++ headers for generic
        # SDK consumers. The libcxx package itself builds from the exact
        # Nix-provided source paths exported below, not from these installed
        # headers.
        llvmTree = pkgs.symlinkJoin {
          name = "llvm-${llvmVersion}-tree";
          paths = [
            llvmPkg.clang-unwrapped
            llvmPkg.llvm
            llvmPkg.lld
            llvmPkg.libcxx
            llvmPkg.libcxx.dev
          ];
        };
        devShellPackages = [
            rustToolchain
            # The wrapper supplies host `cc`, `c++`, `ar`, and linker tools
            # with the pinned Darwin/Linux SDK flags. llvmTree below carries
            # the complete unwrapped LLVM layout used by the Kandelo SDK.
            llvmPkg.clang
            llvmTree
            # Node 24, not 22: the host code constructs
            # WebAssembly.Memory with address: "i64" + BigInt
            # initial/max (memory64), which V8 12.4 (Node 22) does
            # not enable by default. V8 12.9 (Node 24) ships with
            # memory64 on, matching the host Macs the team develops
            # on (system-installed Node 24/25).
            pkgs.nodejs_24
            # Bun: a JavaScriptCore-based runtime. We ship it so the host's
            # teardown reclamation path can be exercised on JSC (the same engine
            # as Safari) in addition to V8 (Node): `npm run test:teardown:engines`
            # in host/ runs host/test/teardown-reclaim.test.ts under both. See
            # docs/jsc-terminate-atomics-wait-workaround.md.
            pkgs.bun
            # Host Erlang for the OTP cross-build bootstrap. Use the
            # minimal interpreter set so CI does not pull in wxWidgets,
            # WebKitGTK, and Xorg just to run `erl`/`erlc`.
            pkgs.beam_minimal.interpreters.erlang_28
            pkgs.cmake
            pkgs.autoconf
            pkgs.automake
            pkgs.libtool
            pkgs.pkg-config
            pkgs.gnumake
            pkgs.bash
            # Package recipes are executed with exactly this declared PATH.
            # Keep the ordinary build-script utilities explicit so Darwin's
            # /usr/bin and ambient host package managers cannot become
            # undeclared fallbacks.
            pkgs.coreutils
            pkgs.findutils
            pkgs.gnused
            pkgs.gnugrep
            pkgs.gawk
            pkgs.diffutils
            pkgs.gzip
            pkgs.file
            pkgs.m4
            # GNU tar is a declared publisher input used for reproducible
            # archive creation across package build and publish scripts.
            pkgs.gnutar
            pkgs.wget
            pkgs.zstd
            pkgs.git
            pkgs.binaryen
            pkgs.wabt
            # cbindgen — required by Mozilla's JS/SpiderMonkey configure
            # path once Rust support is enabled.
            pkgs.rust-cbindgen
            # System tools that build scripts pull from /usr/bin or
            # other ambient host prefixes in non-pure shells. Pinning them via
            # the flake makes `nix develop --ignore-environment` work
            # (so `bash packages/registry/<pkg>/build-*.sh` reproduces CI
            # locally) and removes silent host-version drift between
            # darwin dev boxes and the Ubuntu CI runner. Each is
            # invoked by ≥1 build script:
            #   curl   — every download step (40+ scripts)
            #   perl   — openssl Configure, mariadb cmake codegen,
            #            wget configure, libxml2 (xmllint), etc.
            #   python3 — perl-cross checksize patch, ruby
            #            mkconfig, cpython itself, file's
            #            magic-build, etc.
            #   flex/bison — bash, m4, mariadb (yacc-style parsers)
            #   xz/bzip2 — extracting .tar.xz/.tar.bz2 tarballs and linking
            #            xtask's source extraction helpers.
            #   patch  — applying *.patch files (mariadb, ruby)
            #   gh     — only used by stage-pr-staging release lookup
            pkgs.curl
            pkgs.perl
            pkgs.python3
            # Ruby's standard Psych parser is used by workflow trust tests
            # so workflow contracts are checked as YAML data.
            pkgs.ruby
            pkgs.flex
            pkgs.bison
            pkgs.xz
            pkgs.bzip2
            pkgs.gnupatch
            pkgs.gh
            # GitHub workflow syntax and expression validation. ABI staging
            # plans invoke actionlint through scripts/dev-shell.sh so the
            # validation tool must be part of the pinned repository shell.
            pkgs.actionlint
            # Plans and repository audits use ripgrep for exact bounded path
            # and placeholder checks; do not fall back to an ambient host rg.
            pkgs.ripgrep
            # oras - used by trusted OCI artifact publish workflows to push
            # bytes to GitHub Packages / GHCR.
            pkgs.oras
            # rsync — build-vim-zip.sh / build-shell-vfs-image.sh
            #   use it to copy vim's runtime tree.
            # jq    — fetch-binaries / verify-release / publish-release
            #   parse manifest.json against expected schema.
            # unzip — sqlite source tarball is a .zip; tcl + several
            #   other releases also ship .zip.
            pkgs.rsync
            pkgs.jq
            pkgs.unzip
            # `zip` for build-vim-zip.sh / build-nethack-zip.sh which
            # bundle the vim/nethack runtime trees into the .zip
            # lazy-archives mounted by the shell VFS image. Note: the
            # `packages/registry/zip/` registry entry builds a wasm32 zip
            # binary for user programs — different from the host
            # packager pkgs.zip.
            pkgs.zip
            # texinfo provides `makeinfo` — autotools projects (bc,
            # gawk, m4, …) call it to generate .info docs from .texi
            # sources. Without it, configure passes (it's only
            # WANT_-but-not-required at configure time) and the build
            # dies later with "makeinfo: command not found" on every
            # `*.info` rule.
            pkgs.texinfo
            # help2man generates man(1) pages from a program's --help/
            # --version output. coreutils-docs runs it against a host-side
            # replay wrapper that echoes text captured from the real
            # coreutils.wasm running inside Kandelo — help2man only
            # reformats already-faithful text into troff.
            pkgs.help2man
            # libfaketime provides `faketime`, which the determinism check
            # (scripts/check-determinism.sh → xtask check-determinism) uses to
            # run its two builds under distinct wall clocks. Without it the two
            # builds still differ by a few real seconds, but that weaker clock
            # variation can miss timestamp-embedding non-determinism; faketime
            # forces a large, deterministic clock skew so those gaps surface.
            pkgs.libfaketime
            # Mozilla CA bundle — Nix's curl is built against
            # cacert and looks up its bundle via SSL_CERT_FILE /
            # NIX_SSL_CERT_FILE / GIT_SSL_CAINFO. Pure-shell
            # (`scripts/dev-shell.sh` uses --ignore-environment)
            # strips those env vars from the parent, so without
            # cacert in the flake + the shellHook export below,
            # every HTTPS download fails with curl exit 77 ("Problem
            # with the SSL CA cert"). All ~50 build scripts fetch
            # sources via curl over HTTPS, so this is load-bearing.
            pkgs.cacert
            # libcrypt.so.1 (legacy SONAME) for host miniperl. Ubuntu
            # 24.04 dropped libcrypt.so.1 from default install (libc
            # split crypt(3) out into libxcrypt, which carries
            # libcrypt.so.2 only). perl-cross's host-side Configure
            # link-tests `crypt(3)`, succeeds against the Nix stdlib's
            # libxcrypt-2 symbol-aliases, and bakes
            # `DT_NEEDED libcrypt.so.1` into the resulting miniperl
            # ELF. The dynamic loader can't resolve `.so.1` without
            # this package, so the next make step
            # (`./miniperl_top make_patchnum.pl`) dies with
            # "cannot open shared object file". libxcrypt-legacy
            # explicitly carries the .so.1 SONAME and rpath-binds via
            # the gcc-wrapper.
            pkgs.libxcrypt-legacy
            # Host-side ncurses for MariaDB's Step 1 host build. Its
            # CMake unconditionally calls MYSQL_CHECK_READLINE →
            # FIND_CURSES (CMakeLists.txt:416 → cmake/readline.cmake)
            # even when -DWITH_EDITLINE=bundled is passed; without
            # this, configure fails with "Could NOT find Curses
            # (missing: CURSES_LIBRARY CURSES_INCLUDE_PATH)" before
            # `import_executables.cmake` is generated, so the wasm32
            # cross-build can't proceed. Nix's CMake searches Nix-store
            # paths only, so installing libncurses-dev on the host
            # doesn't help — the lib has to come from nixpkgs.
            pkgs.ncurses
            # sqlite3 CLI — host-side test helper. The WordPress
            # site-editor test (`packages/registry/wordpress/test/wordpress-
            # site-editor.test.ts`) polls the WP install's SQLite DB
            # via `execSync("sqlite3 ...")` to detect when WP is
            # ready; without this every poll prints "/bin/sh: 1:
            # sqlite3: not found" and the test eventually times out
            # at 10 minutes. Different from the wasm32 sqlite we
            # cross-build under packages/registry/sqlite/ — that's the
            # target binary, this is the host CLI used by tests.
            pkgs.sqlite
        ] ++ pkgs.lib.optionals pkgs.stdenv.isDarwin [
            # Mozilla's host configure invokes xcrun directly on Darwin to
            # discover the macOS SDK. Use nixpkgs' implementation so exact
            # package-build PATHs do not fall back to /usr/bin or ambient
            # host prefixes.
            pkgs.xcbuild
        ];
      in {
        devShells.default = pkgs.mkShell {
          packages = devShellPackages;

          shellHook = ''
            # On Darwin, nix develop can leave user profile and ambient
            # host prefix entries ahead of mkShell package bins. Reassert
            # the complete declared tool set, not only Rust, so package builds
            # cannot silently select host CMake, make, or another ambient
            # binary ahead of the flake-pinned version.
            export KANDELO_DEV_SHELL_TOOL_PATH="${pkgs.lib.makeBinPath devShellPackages}"
            export PATH="$KANDELO_DEV_SHELL_TOOL_PATH:$PATH"
            export LLVM_BIN=${llvmTree}/bin
            export LLVM_PREFIX=${llvmTree}
            export LLVM_VERSION=${llvmVersion}
            # mkShell's generic AR=ar/RANLIB=ranlib names fall through to
            # /usr/bin on Darwin because LLVM exposes llvm-* names. Apple ar
            # exits 255 when cc-rs sets ZERO_AR_DATE=1 for reproducible native
            # Rust archives, so bind these variables to the declared LLVM
            # tools instead of ambient host binaries.
            export AR="$LLVM_BIN/llvm-ar"
            export RANLIB="$LLVM_BIN/llvm-ranlib"
            # Same failure shape as AR/RANLIB. mkShell's generic CC=clang and
            # CXX=clang++ resolve through llvmTree, which carries
            # clang-unwrapped. On Darwin that driver has no libc++ or SDK
            # include path, so a package's native host build step fails on
            # `#include <new>`. Bind both to the wrapped clang.
            export CC="${llvmPkg.clang}/bin/clang"
            export CXX="${llvmPkg.clang}/bin/clang++"
            export WASM_POSIX_LLVM_LIBCXX_SOURCE=${llvmPkg.libcxx.src}
            export WASM_POSIX_LLVM_LIBUNWIND_SOURCE=${llvmPkg.libunwind.src}
            # CA bundle for HTTPS — pure-shell strips the user's
            # SSL_CERT_FILE; without an explicit re-export, every
            # `curl https://…` returns exit 77 ("Problem with the
            # SSL CA cert"). pkgs.cacert ships the Mozilla bundle.
            export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"
            export GIT_SSL_CAINFO="$SSL_CERT_FILE"
            # Make libcrypt.so.1 findable at runtime for host miniperl
            # built by perl-cross. mkShell rpath-binds via gcc-wrapper
            # at link time, but if the perl-cross link line comes from
            # an unwrapped invocation (or the wrapper's rpath rules
            # don't fire for SONAME=.so.1), the dynamic loader falls
            # back to LD_LIBRARY_PATH. Belt-and-suspenders.
            export LD_LIBRARY_PATH="${pkgs.libxcrypt-legacy}/lib''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            # Put the worktree-local SDK shims on PATH so wasm32posix-cc
            # / wasm64posix-cc resolve without requiring contributors to
            # source sdk/activate.sh manually. Mirrors what activate.sh
            # does — kept idempotent + tolerant of being run from a
            # subdirectory by anchoring on the flake's repo root via
            # `git rev-parse`. Falls back to $PWD if git isn't usable
            # (shouldn't happen in this repo, but cheap to guard).
            __repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
            if [ -d "$__repo_root/sdk/bin" ]; then
              export KANDELO_DEV_SHELL_TOOL_PATH="$__repo_root/sdk/bin:$KANDELO_DEV_SHELL_TOOL_PATH"
              export PATH="$__repo_root/sdk/bin:$PATH"
            fi
            if [ -f "$__repo_root/scripts/check-dev-shell-tools.sh" ]; then
              bash "$__repo_root/scripts/check-dev-shell-tools.sh"
            fi
            unset __repo_root
            echo "kandelo dev shell — LLVM ${llvmVersion}, Rust (pinned via rust-toolchain.toml), Node 24, Erlang 28 (minimal), SDK on PATH"
          '';
        };
      });
}
