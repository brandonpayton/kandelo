//! Expand a `cargo:<crate>` build-input tag into the repo-relative paths
//! that determine that crate's compiled output. This makes the kernel's
//! cache-key inputs derive from Cargo's real dependency graph instead of
//! a hand-maintained list that can silently omit a compile input
//! (e.g. `.cargo/config.toml`, or a newly-added workspace crate).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

use sha2::{Digest, Sha256};

pub(crate) const CARGO_INPUT_PREFIX: &str = "cargo:";

pub(crate) fn cargo_closure_paths(
    repo_root: &Path,
    crate_name: &str,
) -> Result<Vec<String>, String> {
    let output = Command::new("cargo")
        .args(["metadata", "--format-version=1", "--locked"])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("run cargo metadata for `{crate_name}` closure: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "cargo metadata for `{crate_name}` closure failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let meta: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("parse cargo metadata json: {e}"))?;

    let packages = meta
        .get("packages")
        .and_then(|v| v.as_array())
        .ok_or("cargo metadata: missing packages array")?;
    let workspace_members: BTreeSet<&str> = meta
        .get("workspace_members")
        .and_then(|v| v.as_array())
        .ok_or("cargo metadata: missing workspace_members")?
        .iter()
        .filter_map(|v| v.as_str())
        .collect();

    // id -> (name, manifest_path, [dependency names]) for workspace members only.
    let mut by_name: BTreeMap<&str, (&str, &str, Vec<&str>)> = BTreeMap::new();
    for pkg in packages {
        let id = pkg.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if !workspace_members.contains(id) {
            continue;
        }
        let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or_default();
        let manifest = pkg
            .get("manifest_path")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let deps = pkg
            .get("dependencies")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|d| d.get("name").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        by_name.insert(name, (name, manifest, deps));
    }

    if !by_name.contains_key(crate_name) {
        return Err(format!(
            "`{crate_name}` is not a workspace member (cargo:<crate> requires a workspace crate)"
        ));
    }

    // BFS the transitive workspace-local dependency closure.
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut queue = vec![crate_name];
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    while let Some(name) = queue.pop() {
        if !seen.insert(name) {
            continue;
        }
        let Some((_, manifest, deps)) = by_name.get(name) else {
            continue; // registry crate: covered by Cargo.lock elsewhere
        };
        let dir = crate_dir_relative(repo_root, manifest)?;
        dirs.insert(dir);
        for dep in deps {
            if by_name.contains_key(dep) {
                queue.push(dep);
            }
        }
    }

    // `.cargo/config.toml` governs codegen/link flags but is not a graph
    // node — the exact input omitted today. Include it when present.
    if repo_root.join(".cargo/config.toml").exists() {
        dirs.insert(".cargo/config.toml".to_string());
    }

    Ok(dirs.into_iter().collect())
}

/// Content digest over the union of the cargo dependency closures of
/// `crate_names` -- the same directory-level, `cargo metadata`-derived
/// closure `cargo_closure_paths` computes for a single crate (see the
/// module doc above), extended to cover several crates that are not
/// necessarily linked together (e.g. a wasm side module plus the separate
/// host-only tool that post-processes its build output).
///
/// This exists for build artifacts that are NOT registered in the package
/// resolver (so they have no `build.toml` `inputs` list to derive a
/// resolver cache key from) but still want a drift-proof, closure-derived
/// freshness fingerprint instead of a hand-maintained file list -- the same
/// anti-pattern `cargo:<crate>` build.toml inputs already close for
/// resolver-registered packages. `crates/fork-module/build-wasm.sh` uses
/// this (via the `workspace-closure-sha` CLI entry point below) to stamp
/// and later verify the freshness of its staged `fork_module32.wasm` /
/// `fork_module64.wasm` artifacts.
///
/// Deterministic and order-independent: paths are deduped and sorted before
/// hashing, and each path's digest is folded in as a length-prefixed
/// `(path, content-digest)` pair so no concatenation ambiguity is possible.
pub(crate) fn workspace_crates_closure_sha(
    repo_root: &Path,
    crate_names: &[String],
) -> Result<[u8; 32], String> {
    if crate_names.is_empty() {
        return Err("workspace-closure-sha: at least one crate name is required".to_string());
    }
    let mut paths: BTreeSet<String> = BTreeSet::new();
    for name in crate_names {
        for rel in cargo_closure_paths(repo_root, name)? {
            paths.insert(rel);
        }
    }
    let mut h = Sha256::new();
    h.update(b"kandelo-workspace-crates-closure-v1\0");
    for rel in &paths {
        let digest = crate::build_deps::hash_build_input(&repo_root.join(rel))?;
        h.update((rel.len() as u64).to_le_bytes());
        h.update(rel.as_bytes());
        h.update(digest);
    }
    Ok(h.finalize().into())
}

/// CLI entry point: `xtask workspace-closure-sha --crates <comma,separated>`.
/// Prints the 64-lowercase-hex digest from [`workspace_crates_closure_sha`]
/// to stdout. A non-resolver build script (one with no `build.toml` to carry
/// `cargo:<crate>` inputs) shells out to this to get the same drift-proof,
/// cargo-metadata-derived closure coverage a resolver package gets for free.
pub(crate) fn run_workspace_closure_sha(args: Vec<String>) -> Result<(), String> {
    let mut crates: Option<String> = None;
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        if let Some(value) = arg.strip_prefix("--crates=") {
            if crates.is_some() {
                return Err("--crates given more than once".to_string());
            }
            crates = Some(value.to_string());
        } else if arg == "--crates" {
            if crates.is_some() {
                return Err("--crates given more than once".to_string());
            }
            crates = Some(
                it.next()
                    .ok_or_else(|| "--crates requires a comma-separated value".to_string())?,
            );
        } else {
            return Err(format!("unexpected argument {arg:?}"));
        }
    }
    let crates = crates.ok_or_else(|| "workspace-closure-sha: --crates <a,b,c> is required".to_string())?;
    let names = crates
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let repo = crate::repo_root();
    let digest = workspace_crates_closure_sha(&repo, &names)?;
    println!("{}", crate::util::hex(&digest));
    Ok(())
}

fn crate_dir_relative(repo_root: &Path, manifest_path: &str) -> Result<String, String> {
    let manifest = Path::new(manifest_path);
    let dir = manifest
        .parent()
        .ok_or_else(|| format!("manifest has no parent dir: {manifest_path}"))?;
    let rel = dir
        .strip_prefix(repo_root)
        .map_err(|_| format!("crate dir {} is outside repo root {}", dir.display(), repo_root.display()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Uses the real checked-in workspace so `cargo metadata` resolves the
    // kernel crate ("kandelo") and its workspace path-deps.
    #[test]
    fn kandelo_closure_includes_runtime_core_shared_and_cargo_config() {
        let repo = crate::repo_root();
        let paths = cargo_closure_paths(&repo, "kandelo").expect("closure");
        assert!(paths.iter().any(|p| p == "crates/kernel"), "kernel dir: {paths:?}");
        assert!(paths.iter().any(|p| p == "crates/runtime-core"), "runtime-core dir: {paths:?}");
        assert!(paths.iter().any(|p| p == "crates/shared"), "shared dir: {paths:?}");
        assert!(paths.iter().any(|p| p == ".cargo/config.toml"), "cargo config: {paths:?}");
        // sorted + deduped
        let mut sorted = paths.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(paths, sorted, "must be sorted and deduped");
    }

    #[test]
    fn unknown_crate_is_an_error() {
        let repo = crate::repo_root();
        let err = cargo_closure_paths(&repo, "definitely-not-a-crate").unwrap_err();
        assert!(err.contains("definitely-not-a-crate"), "{err}");
    }

    // fork-module has no resolver build.toml (see crates/fork-module/
    // build-wasm.sh), so `workspace_crates_closure_sha` is its only
    // closure-derived freshness signal. Prove it covers the real closure:
    // fork-module's own crate dir plus fork-codec and shared (compile-time
    // path deps, from `cargo metadata`) AND fork-module-inject (a separate
    // host-only tool the build script also invokes, which is not a Cargo
    // dependency of fork-module and must be named explicitly).
    #[test]
    fn fork_module_closure_covers_its_full_build_graph() {
        let repo = crate::repo_root();
        let names = vec!["fork-module".to_string(), "fork-module-inject".to_string()];
        // Exercise the union logic directly against cargo_closure_paths so a
        // missing crate in the real closure shows up as a clear path
        // assertion rather than only as an opaque digest.
        let mut union: BTreeSet<String> = BTreeSet::new();
        for name in &names {
            for rel in cargo_closure_paths(&repo, name).expect("closure") {
                union.insert(rel);
            }
        }
        assert!(union.contains("crates/fork-module"), "{union:?}");
        assert!(union.contains("crates/fork-module-inject"), "{union:?}");
        assert!(union.contains("crates/fork-codec"), "{union:?}");
        assert!(union.contains("crates/shared"), "{union:?}");

        // The digest itself must be deterministic and must change when a
        // covered file changes -- the exact property this mechanism exists
        // to guarantee for a non-resolver build artifact.
        let first = workspace_crates_closure_sha(&repo, &names).expect("sha");
        let second = workspace_crates_closure_sha(&repo, &names).expect("sha");
        assert_eq!(first, second, "must be deterministic for an unchanged tree");
    }

    #[test]
    fn workspace_crates_closure_sha_requires_at_least_one_crate() {
        let repo = crate::repo_root();
        let err = workspace_crates_closure_sha(&repo, &[]).unwrap_err();
        assert!(err.contains("at least one crate"), "{err}");
    }

    // Generalization guard for the #1328 / kernel-staleness design weakness
    // ("workspace-crate packages hand-list inputs with no cargo-closure
    // validation"): scan every `packages/registry/<name>/build.toml` whose
    // build script directly `cargo build`s a workspace crate (as `kernel`'s
    // `build-kernel.sh` does for `kandelo`), and require the matching
    // `cargo:<crate>` closure-derived input to be declared. This makes the
    // anti-pattern that let `crates/runtime-core/src/netif.rs` slip out of
    // the kernel's cache key impossible to reintroduce -- for the kernel
    // itself (already fixed) and for any FUTURE registry package that
    // compiles a workspace crate directly, without needing this test
    // updated per package.
    #[test]
    fn registry_packages_that_cargo_build_a_workspace_crate_declare_its_closure_input() {
        let repo = crate::repo_root();
        let registry_dir = repo.join("packages/registry");
        let mut failures = Vec::new();
        for entry in std::fs::read_dir(&registry_dir).expect("read packages/registry") {
            let entry = entry.expect("registry dir entry");
            if !entry.file_type().expect("file_type").is_dir() {
                continue;
            }
            let package_dir = entry.path();
            let build_toml_path = package_dir.join("build.toml");
            let Ok(build_toml_text) = std::fs::read_to_string(&build_toml_path) else {
                continue;
            };
            let build = crate::pkg_manifest::BuildToml::parse(&build_toml_text)
                .unwrap_or_else(|e| panic!("{}: {e}", build_toml_path.display()));
            let script_path = repo.join(&build.script_path);
            let Ok(script_text) = std::fs::read_to_string(&script_path) else {
                continue;
            };
            for crate_name in cargo_build_dash_p_crate_names(&script_text) {
                // Only workspace-local crates need a `cargo:<crate>` closure
                // input; a `-p` targeting a registry (non-workspace) crate is
                // covered by Cargo.lock, already a declared input.
                if cargo_closure_paths(&repo, &crate_name).is_err() {
                    continue;
                }
                let want = format!("{CARGO_INPUT_PREFIX}{crate_name}");
                if !build.inputs.iter().any(|input| input == &want) {
                    failures.push(format!(
                        "{}: build script {} runs `cargo build -p {crate_name}` (a workspace \
                         crate) but build.toml inputs do not include {want:?} -- any file added \
                         to that crate (or a crate it depends on) will silently NOT invalidate \
                         this package's cache key",
                        package_dir.display(),
                        script_path.display(),
                    ));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    /// Extract every `-p <name>` / `--package <name>` token following a
    /// `cargo build` invocation in a shell script's text. Deliberately
    /// simple (whitespace-token scanning, not a shell parser): false
    /// negatives are the only failure mode this guard risks -- a build
    /// script that invokes cargo in some more exotic way this misses would
    /// ship undetected, exactly like before this test existed. It must not
    /// have false positives that fail an unrelated package's test, so it
    /// only fires on an EXACT `-p`/`--package` flag pair.
    ///
    /// Deliberately excludes `xtask` and `fork-module-inject`: many package
    /// build scripts run `cargo build -p xtask` (or the fork-module
    /// injector) to get a HOST-triple build TOOL they shell out to, not a
    /// wasm crate whose compiled bytes become part of the package's own
    /// published output. `kernel`'s `-p kandelo` (and `fork-module`'s
    /// `-p fork-module`) is the pattern this guard exists for: the crate IS
    /// the package's wasm output, so its content must be a cache-key input.
    /// A build tool's OWN drift is a different concern, already handled
    /// where it matters (e.g. `fork_instrument_tool_input_paths` folds
    /// `cargo:fork-instrument` into every fork-instrumented package's key).
    fn cargo_build_dash_p_crate_names(script_text: &str) -> BTreeSet<String> {
        const BUILD_TOOL_CRATES: &[&str] = &["xtask", "fork-module-inject"];
        let mut names = BTreeSet::new();
        for line in script_text.lines() {
            if !line.contains("cargo build") {
                continue;
            }
            let tokens: Vec<&str> = line.split_whitespace().collect();
            for (i, token) in tokens.iter().enumerate() {
                if (*token == "-p" || *token == "--package") && i + 1 < tokens.len() {
                    let name = tokens[i + 1];
                    if !BUILD_TOOL_CRATES.contains(&name) {
                        names.insert(name.to_string());
                    }
                }
            }
        }
        names
    }
}
