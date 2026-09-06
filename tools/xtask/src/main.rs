//! xtask — repo-local utilities.
//!
//! Subcommands:
//!   dump-abi              Regenerate `abi/snapshot.json` from authoritative sources.
//!   bundle-program        Zip-bundle one program's binary + runtime + LICENSE.
//!   build-deps            Wasm library dep-graph resolver (see docs/dependency-management.md).
//!   compute-cache-key-sha Print a package's cache-key sha (64 hex chars) to stdout.
//!                         Args: --package <dir> --arch <wasm32|wasm64>. Used by the
//!                         pre-flight workflow to skip already-published
//!                         matrix entries.
//!   workspace-closure-sha Print a content digest (64 hex chars) over the union
//!                         of one or more workspace crates' cargo dependency
//!                         closures. Args: --crates <a,b,c>. For a build
//!                         artifact with no resolver `build.toml` (so it has
//!                         no `cargo:<crate>` cache-key input), this gives the
//!                         same drift-proof, cargo-metadata-derived freshness
//!                         coverage. Used by `crates/fork-module/build-wasm.sh`.
//!   sort-package-matrix   Order a package matrix so selected package dependencies
//!                         appear before their dependents.
//!   partition-package-matrix
//!                         Select an exact root closure and partition it into
//!                         dependency-safe parallel build levels.
//!   package-dependency-artifacts
//!                         Print workflow artifact names for selected direct
//!                         package dependencies of one package matrix entry.
//!   archive-extract-member
//!                         Stream one exact regular package-archive member to
//!                         a new output file without exposing partial bytes.
//!   local-build           Resolve and source-build a package closure locally.
//!   bootstrap             One-command hermetic build: fork-instrument host
//!                         tool, then the local-build engine over the whole
//!                         supported set, then the TypeScript host build.
//!                         Backs `./run.sh setup`.
//!   clean                 Remove one package's or product's compiled cache,
//!                         mirror, and product artifacts, and print the
//!                         graph-derived cascade of nodes it also
//!                         invalidates (e.g. cleaning a package a VFS
//!                         product embeds also invalidates that product).
//!                         Backs `./run.sh clean <target>`.
//!   verify-fresh          Pre-test freshness check: fails loud if the one
//!                         local kernel artifact (local-binaries/source-only-v1/
//!                         kernel.wasm) declares a stale ABI version
//!                         relative to the source tree. Backs `./run.sh test`.
//!   set-build-commit      Stamp `[build].commit = <sha>` into one
//!                         `packages/registry/<name>/package.toml`. Used by the
//!                         publish flow to record source provenance.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::rc::Rc;

mod vfs_products;
mod archive_extract_member;
mod build_deps;
mod build_stamp;
mod bundle_program;
mod cargo_closure;
mod determinism_check;
mod dump_abi;
mod host_tool_probe;
mod local_abi_identity;
mod local_build;
mod local_build_executor;
mod package_archive_limits;
mod package_matrix;
mod pkg_manifest;
mod remote_fetch;
mod source_archive_cache;
mod source_extract;
mod update_pkg_manifest;
mod util;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let sub = match args.next() {
        Some(s) => s,
        None => {
            eprintln!("usage: xtask <subcommand> [args...]");
            eprintln!(
                "subcommands: vfs, dump-abi, bundle-program, build-deps, compute-cache-key-sha, sort-package-matrix, partition-package-matrix, package-dependency-artifacts, archive-extract-member, set-build-commit, local-build, check-determinism, bootstrap, clean, verify-fresh"
            );
            return ExitCode::from(2);
        }
    };
    let rest: Vec<String> = args.collect();
    if sub == "vfs" {
        return vfs_products::run(rest);
    }
    let result = match sub.as_str() {
        "dump-abi" => dump_abi::run(rest),
        "bundle-program" => bundle_program::run(rest),
        "build-deps" => build_deps::run(rest),
        "compute-cache-key-sha" => build_deps::run_compute_cache_key_sha(rest),
        "workspace-closure-sha" => cargo_closure::run_workspace_closure_sha(rest),
        "sort-package-matrix" => package_matrix::run_sort(rest),
        "partition-package-matrix" => package_matrix::run_partition(rest),
        "package-dependency-artifacts" => package_matrix::run_dependency_artifacts(rest),
        "archive-extract-member" => archive_extract_member::run(rest),
        "set-build-commit" => update_pkg_manifest::run(rest),
        "local-build" => local_build::run(rest),
        "check-determinism" => determinism_check::run(rest),
        "bootstrap" => local_build::run_bootstrap(rest),
        "clean" => local_build::run_clean(rest),
        "verify-fresh" => local_build::run_verify_fresh(rest),
        other => {
            eprintln!("xtask: unknown subcommand {other:?}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("xtask {sub}: {e}");
            ExitCode::from(1)
        }
    }
}

thread_local! {
    static REPO_ROOT_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

pub(crate) struct RepoRootOverrideGuard {
    // The guard resets thread-local state and therefore must be dropped on the
    // same thread that installed it.
    _not_send: PhantomData<Rc<()>>,
}

impl Drop for RepoRootOverrideGuard {
    fn drop(&mut self) {
        REPO_ROOT_OVERRIDE.with(|slot| {
            *slot.borrow_mut() = None;
        });
    }
}

pub(crate) fn install_repo_root_override(root: PathBuf) -> Result<RepoRootOverrideGuard, String> {
    REPO_ROOT_OVERRIDE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err("xtask repository-root override is already installed".to_string());
        }
        *slot = Some(root);
        Ok(())
    })?;
    // WHY: the override belongs to one build-deps command, not ambient process
    // state. Restoring it on every return (including unwinding) keeps unit tests
    // and future in-process callers from inheriting another command's identity.
    Ok(RepoRootOverrideGuard {
        _not_send: PhantomData,
    })
}

pub fn repo_root() -> PathBuf {
    if let Some(root) = REPO_ROOT_OVERRIDE.with(|slot| slot.borrow().clone()) {
        return root;
    }
    // CARGO_MANIFEST_DIR points to tools/xtask/; go up two levels.
    let manifest = env!("CARGO_MANIFEST_DIR");
    Path::new(manifest)
        .parent()
        .and_then(Path::parent)
        .unwrap()
        .to_path_buf()
}

pub type JsonMap = BTreeMap<String, serde_json::Value>;
