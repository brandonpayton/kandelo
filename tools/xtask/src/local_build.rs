use crate::vfs_products::canonical_json::{canonical_json_bytes, canonical_sha256};
use crate::vfs_products::product_manifest::{
    CatalogWriteMode, VfsArchitectureV1, VfsProductCatalogEntryV1, VfsProductManifestV1,
    parse_product_manifest_bytes, validate_product_catalog_entries, write_or_check_product_catalog,
};
use crate::archive_extract_member::rename_no_replace;
use crate::build_deps::{
    LocalBuildDisposition, MaterializedProgramMemberV1, PackageNodeReceiptV1,
    ProgramPackageIndex, Registry, ResolvedDependencyGraph, ResolvedDependencyNode,
    SourceOnlyCacheRoots, canonical_package_target_arch,
    materialize_planned_source_only_cache_roots, plan_canonical_source_only_cache_roots,
    read_source_only_cache_receipt, resolve_local_build_package_node_with_cache_policy,
    resolved_dependency_graph_from_manifests, source_only_cache_receipt_path,
    source_only_skip_receipt_if_clean, source_only_program_package_index_for_nodes,
    with_source_only_program_projection_lock,
};
use crate::local_build_executor::{
    NodeCompletionV1, SchedulerEventV1, ValidatedChildResultV1, execute_graph_with_events,
    validate_child_result,
};
use crate::pkg_manifest::{BuildToml, DepsManifest, ManifestKind, SourceProvider, TargetArch};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

const LOCAL_SUPPORTED_SCHEMA: u32 = 1;
const LOCAL_SUPPORTED_POLICY: &str = "source-only-v1";
const MAX_SET_BYTES: usize = 1024 * 1024;
const MAX_GRAPH_MANIFEST_BYTES: usize = 1024 * 1024;
const GRAPH_AUTHORITY_DOMAIN: &[u8] = b"kandelo-local-build-graph-authority-v1\0";
const SOURCE_ONLY_PROGRAM_PROJECTION_FORMAT: &str =
    "kandelo-source-only-program-projection-v1";
const SOURCE_ONLY_PROGRAM_PROJECTION_LIMIT: usize = 16 * 1024 * 1024;
const SOURCE_ONLY_PROGRAM_MEMBER_LIMIT: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalSupportedSetV1 {
    schema: u32,
    policy: String,
    packages: Vec<SupportedPackageV1>,
    products: Vec<SupportedProductV1>,
    exclusions: Vec<ExcludedRootV1>,
    dependency_only: Vec<String>,
    registry_non_roots: Vec<ExcludedRootV1>,
    dormant_products: Vec<ExcludedRootV1>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SupportedPackageV1 {
    name: String,
    class: LocalRootClass,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum LocalRootClass {
    BrowserProduct,
    TestSupport,
    Platform,
    UserSoftware,
}

impl LocalRootClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::BrowserProduct => "browser-product",
            Self::TestSupport => "test-support",
            Self::Platform => "platform",
            Self::UserSoftware => "user-software",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SupportedProductV1 {
    id: String,
    package: String,
    manifest: String,
    #[serde(default)]
    package_dependencies: Vec<String>,
    #[serde(default)]
    root_mirror_packages: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExcludedRootV1 {
    name: String,
    reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct LocalBuildPlanV1 {
    schema: u32,
    policy: String,
    packages: Vec<PlannedPackageV1>,
    products: Vec<PlannedProductV1>,
    levels: Vec<Vec<PlanNodeV1>>,
    exclusions: Vec<PlanExclusionV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PlannedGraphV1 {
    plan: LocalBuildPlanV1,
    dependencies: BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    authority: GraphAuthorityV1,
    authority_sha256: String,
    product_execution: BTreeMap<String, ProductExecutionAuthorityV1>,
}

impl std::ops::Deref for PlannedGraphV1 {
    type Target = LocalBuildPlanV1;

    fn deref(&self) -> &Self::Target {
        &self.plan
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct PlannedPackageV1 {
    name: String,
    class: String,
    reason: String,
    architectures: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct PlannedProductV1 {
    id: String,
    package: String,
    manifest: String,
    architecture: String,
    reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum PlanNodeV1 {
    Package { name: String, target_arch: String },
    Product { id: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LocalBuildRunResultV1 {
    pub(crate) schema: u32,
    pub(crate) policy: String,
    pub(crate) outcome: AggregateOutcomeV1,
    pub(crate) nodes: Vec<NodeRunResultV1>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum AggregateOutcomeV1 {
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SuccessDispositionV1 {
    Cached,
    Published,
    RebuiltEquivalent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum NodeRunResultV1 {
    Succeeded {
        node: PlanNodeV1,
        disposition: SuccessDispositionV1,
    },
    Failed {
        node: PlanNodeV1,
        exit_code: Option<i32>,
    },
    Blocked {
        node: PlanNodeV1,
        failed_ancestors: Vec<PlanNodeV1>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NodeExecutionResultV1 {
    pub(crate) schema: u32,
    pub(crate) policy: String,
    pub(crate) result: NodeRunResultV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) package_receipt: Option<PackageNodeReceiptV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceOnlyProgramProjectionV1 {
    format: &'static str,
    projection: ProgramPackageIndex,
    graph_authority_sha256: String,
    nodes: Vec<SourceOnlyProgramNodeV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceOnlyProgramNodeV1 {
    node: SourceOnlyProgramNodeIdentityV1,
    manifest_sha256: String,
    cache_key_sha256: String,
    cache_receipt_sha256: String,
    members: Vec<MaterializedProgramMemberV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceOnlyProgramNodeIdentityV1 {
    kind: &'static str,
    name: String,
    target_arch: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleTokenV1 {
    Ready,
    Queued,
    Running,
    Continuing,
    Cached,
    Reused,
    Succeeded,
    Blocked,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum LocalBuildCommandV1 {
    Plan { set: PathBuf },
    Run(LocalBuildRunArgsV1),
    RunNode(LocalBuildRunNodeArgsV1),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LocalBuildRunArgsV1 {
    set: PathBuf,
    source_cache_root: PathBuf,
    output_root: PathBuf,
    products: Vec<String>,
    jobs: usize,
    rebuild: bool,
    verify_cache: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LocalBuildRunNodeArgsV1 {
    repo_root: PathBuf,
    set: PathBuf,
    graph_authority_sha256: String,
    source_cache_root: PathBuf,
    compiled_cache_root: PathBuf,
    output_root: PathBuf,
    node: PlanNodeV1,
    result_json: PathBuf,
    rebuild: bool,
    verify_cache: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct GraphAuthorityV1 {
    schema: u32,
    policy: String,
    supported_set_sha256: String,
    registry_package_toml: Vec<RegistryPackageTomlAuthorityV1>,
    nodes: Vec<PlanNodeV1>,
    direct_edges: Vec<GraphDirectEdgeV1>,
    product_bindings: Vec<ProductBindingV1>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct RegistryPackageTomlAuthorityV1 {
    repo_relative_path: String,
    raw_sha256: String,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct GraphDirectEdgeV1 {
    dependency: PlanNodeV1,
    dependent: PlanNodeV1,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct ProductBindingV1 {
    id: String,
    mapped_package: String,
    target_arch: String,
    repo_relative_manifest_path: String,
    manifest_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProductExecutionAuthorityV1 {
    binding: ProductBindingV1,
    manifest: VfsProductManifestV1,
}

impl PlanNodeV1 {
    pub(crate) fn package(name: &str, target_arch: &str) -> Self {
        Self::Package {
            name: name.to_string(),
            target_arch: target_arch.to_string(),
        }
    }

    pub(crate) fn product(id: &str) -> Self {
        Self::Product { id: id.to_string() }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
struct PlanExclusionV1 {
    name: String,
    disposition: String,
    reason: String,
}

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    let explicit_jobs = args
        .iter()
        .any(|value| value == "--jobs" || value.starts_with("--jobs="));
    let environment_jobs = if explicit_jobs {
        None
    } else {
        std::env::var_os("WASM_POSIX_LOCAL_BUILD_JOBS")
            .map(|value| {
                value
                    .into_string()
                    .map_err(|_| "WASM_POSIX_LOCAL_BUILD_JOBS must be valid UTF-8".to_string())
            })
            .transpose()?
    };
    let command = parse_local_build_args_with_jobs(
        &args,
        environment_jobs.as_deref(),
        std::thread::available_parallelism().ok(),
    )?;
    match command {
        LocalBuildCommandV1::Plan { set } => run_plan(set),
        LocalBuildCommandV1::Run(args) => run_aggregate(args),
        LocalBuildCommandV1::RunNode(args) => run_node(args),
    }
}

pub(crate) struct BootstrapStep {
    pub name: &'static str,
}

/// The ordered host-plus-engine build closure for `xtask bootstrap` /
/// `./run.sh setup`. Pure and testable: `fork-instrument-tool` must precede
/// `engine` (the `msmtpd` package node consumes the built
/// `wasm-fork-instrument` CLI); `sysroot`/`sysroot64`/`sdk` must precede
/// `engine` (every package build script in the local-supported set reads the
/// ambient `sysroot`/`sysroot64` musl toolchain and the `wasm{32,64}posix-cc`
/// wrappers directly — this is not a graph edge the engine's own dependency
/// resolution models, so nothing rebuilds it as a side effect of building a
/// package node; `sdk` itself only checks that `sysroot`'s toolchain wrappers
/// resolve, so it must run after `sysroot`); `rootfs` must follow `engine`
/// (`build-rootfs.sh` assembles the canonical `host/wasm/rootfs.vfs` image
/// from packages the engine step just built) and precede `host-dist` (the
/// TypeScript host build should see a fresh rootfs image, even though it
/// does not currently read it at build time); `host-dist` must follow
/// `engine` (the TypeScript host build consumes the program package index
/// the engine regenerates).
pub(crate) fn bootstrap_step_plan() -> Vec<BootstrapStep> {
    vec![
        BootstrapStep {
            name: "fork-instrument-tool",
        },
        BootstrapStep { name: "sysroot" },
        BootstrapStep {
            name: "sysroot64",
        },
        BootstrapStep { name: "sdk" },
        BootstrapStep { name: "engine" },
        BootstrapStep { name: "rootfs" },
        BootstrapStep {
            name: "host-dist",
        },
    ]
}

/// Default `--source-cache-root` for `bootstrap`, matching
/// `scripts/run-local-build.sh` so the engine step here and the
/// `./run.sh local-build` front door share one persistent cache location.
///
/// The SourceOnly build cache is shared across every worktree on the
/// machine by default (it is content-addressed, so identical inputs are
/// built once and reused everywhere — this is what keeps a fresh worktree
/// fast). Setting `KANDELO_SOURCE_CACHE_ROOT` to an absolute path gives a
/// worktree its own isolated cache instead; leaving it unset shares the
/// machine-wide default. See `docs/agent-guidance/packages-and-builds.md`.
fn default_source_cache_root() -> Result<PathBuf, String> {
    resolve_source_cache_root(
        std::env::var_os("KANDELO_SOURCE_CACHE_ROOT"),
        std::env::var_os("HOME"),
    )
}

/// Pure resolver behind [`default_source_cache_root`]: an explicit
/// `KANDELO_SOURCE_CACHE_ROOT` override (must be absolute) wins; otherwise
/// fall back to `$HOME/.cache/kandelo/source-only`. Split out so the
/// override precedence is unit-testable without mutating process env.
fn resolve_source_cache_root(
    override_root: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    if let Some(override_root) = override_root {
        let override_root = PathBuf::from(override_root);
        if !override_root.is_absolute() {
            return Err(format!(
                "KANDELO_SOURCE_CACHE_ROOT must be an absolute path, got {}",
                override_root.display()
            ));
        }
        return Ok(override_root);
    }
    let home =
        home.ok_or_else(|| "bootstrap: HOME is not set; cannot locate source cache root".to_string())?;
    let home = PathBuf::from(home);
    if !home.is_absolute() {
        return Err(format!(
            "bootstrap: HOME must be an absolute path, got {}",
            home.display()
        ));
    }
    Ok(home.join(".cache/kandelo/source-only"))
}

/// Run `bash <repo>/<rel> <args...>` with inherited stdio, so bootstrap steps
/// stream their normal output exactly as they would run standalone. Returns
/// `Err` on a non-zero exit or a failure to launch the script.
fn run_repo_script(repo: &Path, rel: &str, args: &[&str]) -> Result<(), String> {
    run_repo_script_with_env(repo, rel, args, &[])
}

/// Same as `run_repo_script`, plus extra environment variables set on the
/// child process. Used by the `rootfs`/`host-dist` bootstrap steps to pass
/// `KANDELO_BOOTSTRAP_FORCE_REBUILD` through to their scripts' own
/// input-hash skip check (see `scripts/build-step-input-hash.sh`), without
/// changing the call shape every other `run_repo_script` caller uses.
fn run_repo_script_with_env(
    repo: &Path,
    rel: &str,
    args: &[&str],
    envs: &[(&str, &str)],
) -> Result<(), String> {
    let script = repo.join(rel);
    let mut command = Command::new("bash");
    command.arg(&script).args(args).current_dir(repo);
    for (key, value) in envs {
        command.env(key, value);
    }
    let status = command
        .status()
        .map_err(|error| format!("spawn {}: {error}", script.display()))?;
    if !status.success() {
        return Err(format!(
            "{} exited with {}",
            script.display(),
            match status.code() {
                Some(code) => code.to_string(),
                None => "no exit code (terminated by signal)".to_string(),
            }
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Selection {
    /// The whole-tree build closure: `bootstrap_step_plan()` in order.
    All,
    /// A single registry package or declared VFS product, built through the
    /// local-build engine's `--products`-style selection (which already
    /// resolves the transitive dependency closure and content-addressed
    /// cache policy for whatever it is given).
    Package(String),
    /// A host-side step that is not a local-build engine graph node (the
    /// fork-instrument CLI, the TypeScript host build, the rootfs image, and
    /// the ambient musl sysroot/SDK). Named after the step in
    /// `bootstrap_step_plan`/`run_bootstrap_step` it maps to.
    HostStep(&'static str),
}

/// Map a single `xtask bootstrap <target>` positional to what it selects.
/// Pure and total: every target string resolves to a `Selection`, deferring
/// "does this actually exist" to the engine/host-step runner, which already
/// has the real registry and product catalog available to validate against.
///
/// `host`, `fork-instrument`, `rootfs`, `sysroot`, `sysroot64`, and `sdk` are
/// the non-graph host steps `./run.sh`'s `need_host`/`need_fork_instrument`/
/// `need_rootfs`/`need_sysroot`/`need_sysroot64`/`need_sdk` used to build by
/// hand; everything else (`kernel`, `zlib`, `php`, `mariadb-vfs`, ...) is a
/// package or product name the engine's own graph already understands.
pub(crate) fn bootstrap_target_to_selection(target: &str) -> Selection {
    match target {
        "host" => Selection::HostStep("host-dist"),
        "fork-instrument" => Selection::HostStep("fork-instrument-tool"),
        "rootfs" => Selection::HostStep("rootfs"),
        "sysroot" => Selection::HostStep("sysroot"),
        "sysroot64" => Selection::HostStep("sysroot64"),
        "sdk" => Selection::HostStep("sdk"),
        other => Selection::Package(other.to_string()),
    }
}

/// Whether a bare `xtask bootstrap <target>` package selection needs the
/// wasm64 musl sysroot provisioned before the engine builds it, mirroring
/// the historical "64" suffix convention `select_graph_dependencies` already
/// uses to map a target like `mariadb64` onto the wasm64 node of the
/// `mariadb` package: a target name ending in "64" is a wasm64 build: every
/// other target defaults to wasm32 and needs only the (already-required,
/// via the `sdk` step) wasm32 sysroot. `sysroot64` itself is handled by its
/// own `Selection::HostStep` arm, not this package-prerequisite path.
pub(crate) fn package_target_needs_sysroot64(target: &str) -> bool {
    target.ends_with("64")
}

/// Parse the leading positional target argument of `xtask bootstrap`. An
/// omitted target and the explicit literal `all` both select the whole-tree
/// build closure; any other positional is resolved by
/// `bootstrap_target_to_selection`. Pure and testable, split out of
/// `run_bootstrap` so the argument-shape decision can be verified without
/// running the bootstrap steps.
pub(crate) fn bootstrap_selection_from_args(
    args: &[String],
) -> Result<(Selection, Vec<String>), String> {
    let (target, rest) = match args.split_first() {
        Some((first, rest)) if !first.starts_with("--") => (Some(first.clone()), rest.to_vec()),
        _ => (None, args.to_vec()),
    };
    match target.as_deref() {
        None | Some("all") => Ok((Selection::All, rest)),
        Some(target) => Ok((bootstrap_target_to_selection(target), rest)),
    }
}

/// The set of `[[products]]` ids `local-supported.toml` declares active for
/// the local-build engine. Used to check that a `./run.sh build <target>`
/// name naming a VFS composite (`shell-vfs`, `wp-vfs`, ...) actually has a
/// declared product `xtask bootstrap <id>` can select — see
/// `bootstrap_target_to_selection`'s `Selection::Package` arm, which accepts
/// both declared product ids and bare package names through the same
/// `select_graph_dependencies` filter.
///
/// Only used by `run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries`
/// below; `#[cfg(test)]` keeps the non-test binary free of a dead-code
/// warning (matching how `parse_supported_set`, its sole other caller's
/// dependency, is also test-only today).
#[cfg(test)]
fn declared_product_ids(set: &LocalSupportedSetV1) -> BTreeSet<String> {
    set.products
        .iter()
        .map(|product| product.id.clone())
        .collect()
}

/// Absolute path to the worktree-local SDK's compiler wrapper. Its presence
/// (as a working symlink to a real file) is the same signal
/// `has_sdk`/`command -v wasm32posix-cc` checked in `run.sh`, checked
/// directly instead of through PATH so this does not depend on the caller
/// having sourced `sdk/activate.sh`.
fn sdk_cc_path(repo: &Path) -> PathBuf {
    repo.join("sdk/bin/wasm32posix-cc")
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Ensure the musl sysroot for `arch` exists, mirroring the old
/// `need_sysroot`/`need_sysroot64`: build it from scratch when the sysroot's
/// `libc.a` is missing, otherwise just re-sync overlay headers (cheap: a few
/// `cp`s) so newly added `libc/musl-overlay/include/` files reach an
/// existing sysroot without forcing a full musl rebuild.
fn bootstrap_sysroot_step(repo: &Path, sysroot_dir: &str, arch: &str) -> Result<(), String> {
    let sysroot_path = repo.join(sysroot_dir);
    let libc_a = sysroot_path.join("lib/libc.a");
    if libc_a.is_file() {
        let sysroot_arg = sysroot_path.to_string_lossy().into_owned();
        run_repo_script(repo, "scripts/install-overlay-headers.sh", &[&sysroot_arg])
    } else if arch == "wasm32posix" {
        run_repo_script(repo, "scripts/build-musl.sh", &[])
    } else {
        run_repo_script(repo, "scripts/build-musl.sh", &["--arch", arch])
    }
}

/// Run one named bootstrap step. Shared by the whole-tree `Selection::All`
/// loop and single-target selection, so a target built alone (e.g.
/// `bootstrap kernel`) and the same step run as part of `bootstrap all` do
/// exactly the same thing.
fn run_bootstrap_step(
    repo: &Path,
    name: &str,
    jobs: usize,
    rebuild: bool,
    verify_cache: bool,
    products: Vec<String>,
) -> Result<(), String> {
    match name {
        "fork-instrument-tool" => {
            run_repo_script(repo, "scripts/build-fork-instrument-tool.sh", &[])
        }
        "engine" => run_aggregate(LocalBuildRunArgsV1 {
            set: repo.join("packages/sets/local-supported.toml"),
            source_cache_root: default_source_cache_root()?,
            output_root: repo.join("local-binaries/source-only-v1"),
            products,
            jobs,
            rebuild,
            verify_cache,
        }),
        // `--rebuild` (`bootstrap --rebuild` / `./run.sh rebuild`) must force
        // these two scripts' own input-hash skip check, so a forced rebuild
        // is never masked by a matching stamp from a previous run.
        "rootfs" => run_repo_script_with_env(
            repo,
            "scripts/build-rootfs.sh",
            &[],
            &[(
                "KANDELO_BOOTSTRAP_FORCE_REBUILD",
                if rebuild { "1" } else { "0" },
            )],
        ),
        "host-dist" => run_repo_script_with_env(
            repo,
            "scripts/build-host.sh",
            &[],
            &[(
                "KANDELO_BOOTSTRAP_FORCE_REBUILD",
                if rebuild { "1" } else { "0" },
            )],
        ),
        "sysroot" => bootstrap_sysroot_step(repo, "sysroot", "wasm32posix"),
        "sysroot64" => bootstrap_sysroot_step(repo, "sysroot64", "wasm64posix"),
        "sdk" => {
            bootstrap_sysroot_step(repo, "sysroot", "wasm32posix")?;
            if is_executable_file(&sdk_cc_path(repo)) {
                Ok(())
            } else {
                Err(format!(
                    "bootstrap sdk: SDK tools not found. Expected {} to be a working symlink.",
                    sdk_cc_path(repo).display()
                ))
            }
        }
        other => Err(format!("bootstrap: unknown step {other:?}")),
    }
}

/// `xtask bootstrap [<target>] [--jobs <n>] [--rebuild] [--verify-cache]` —
/// the single engine-plus-host build closure behind `./run.sh setup` and
/// `./run.sh build <target>`. An omitted target (or the explicit literal
/// `all`) builds the whole tree via `bootstrap_step_plan()`; any other
/// target selects one package/product (routed through the engine's own
/// dependency-closure and cache-key selection) or one non-graph host step
/// (see `bootstrap_target_to_selection`).
pub(crate) fn run_bootstrap(args: Vec<String>) -> Result<(), String> {
    let (selection, rest) = bootstrap_selection_from_args(&args)?;
    let repo = crate::repo_root();
    let mut flags = parse_named_flags(&rest, &["--jobs"], &[], &["--rebuild", "--verify-cache"])?;
    let jobs = select_job_count(
        flags.values.remove("--jobs").as_deref(),
        std::env::var("WASM_POSIX_LOCAL_BUILD_JOBS").ok().as_deref(),
        std::thread::available_parallelism().ok(),
    )?;
    let rebuild = flags.switches.contains("--rebuild");
    let verify_cache = flags.switches.contains("--verify-cache");
    match selection {
        Selection::All => {
            for step in bootstrap_step_plan() {
                let products = if step.name == "engine" {
                    vec!["all".to_string()]
                } else {
                    Vec::new()
                };
                run_bootstrap_step(&repo, step.name, jobs, rebuild, verify_cache, products)?;
            }
            Ok(())
        }
        Selection::HostStep(name) => {
            // The old `need_host` built the kernel before the TypeScript host
            // (`host/dist` embeds/tests against it); preserve that edge for a
            // standalone `bootstrap host` the same way `bootstrap_step_plan`
            // preserves it for the whole-tree path by ordering "engine"
            // before "host-dist".
            if name == "host-dist" {
                run_bootstrap_step(
                    &repo,
                    "engine",
                    jobs,
                    rebuild,
                    verify_cache,
                    vec!["kernel".to_string()],
                )?;
            }
            run_bootstrap_step(&repo, name, jobs, rebuild, verify_cache, Vec::new())
        }
        Selection::Package(name) => {
            // Preserve the exact universal prerequisite set every `run.sh`
            // `build_<pkg>` relied on (`need_kernel` + `need_sdk`, which
            // itself ensures `need_sysroot`), except for the kernel itself,
            // which is a pure `cargo build` with no kernel/SDK/musl
            // dependency of its own. `sdk`'s own step ensures `sysroot`
            // first (see its `run_bootstrap_step` arm), so this only needs
            // to ensure `kernel` and `sdk` directly — the `sysroot` resync
            // underneath `sdk` is cheap when it already exists.
            if name != "kernel" {
                run_bootstrap_step(
                    &repo,
                    "engine",
                    jobs,
                    rebuild,
                    verify_cache,
                    vec!["kernel".to_string()],
                )?;
                run_bootstrap_step(&repo, "sdk", jobs, rebuild, verify_cache, Vec::new())?;
                // `need_sysroot64` on memory64 paths: the wasm64 build of a
                // package (`./run.sh build mariadb64`, `sysroot64` itself
                // handled by its own `Selection::HostStep` arm) additionally
                // needs the wasm64 musl sysroot the wasm32 `sdk` step above
                // does not provision. Only pay for this when the target
                // actually names a wasm64 build — not on every package.
                if package_target_needs_sysroot64(&name) {
                    run_bootstrap_step(&repo, "sysroot64", jobs, rebuild, verify_cache, Vec::new())?;
                }
            }
            // msmtpd is the one package that consumes the built
            // wasm-fork-instrument CLI (see `bootstrap_step_plan`'s doc
            // comment); every other package does not need it.
            if name == "msmtpd" {
                run_bootstrap_step(
                    &repo,
                    "fork-instrument-tool",
                    jobs,
                    rebuild,
                    verify_cache,
                    Vec::new(),
                )?;
            }
            run_bootstrap_step(&repo, "engine", jobs, rebuild, verify_cache, vec![name])
        }
    }
}

/// `xtask verify-fresh` — a pre-test freshness check, not a divergence guard.
/// Stage 2 converged Node and browser binary resolution onto the one
/// hermetic tier `local-binaries/source-only-v1/` (see `binaryCandidateTiers`
/// in `host/src/binary-resolver.ts`), so there is exactly one kernel copy to
/// go stale, not two copies that could diverge from each other. This closes
/// the documented hazard that Vitest/conformance can silently exercise a
/// kernel built before the last source change
/// (`docs/plans/2026-08-25-rust-first-runtime-design.md`): `./run.sh test`
/// calls this before its suites run so a stale kernel fails loud instead of
/// passing tests against yesterday's ABI.
pub(crate) fn run_verify_fresh(args: Vec<String>) -> Result<(), String> {
    if !args.is_empty() {
        return Err(format!(
            "verify-fresh: unexpected argument(s): {}",
            args.join(" ")
        ));
    }
    verify_fresh_report(&crate::repo_root())
}

/// Compare the ABI version the local-build engine's one kernel artifact
/// declares against the ABI version the source tree currently builds. `Ok`
/// covers both "current" and "no local kernel build yet" (nothing can be
/// stale before `./run.sh setup`/`bootstrap` has produced this tier; the
/// resolver's own "binary not found" error already reports that plainly).
///
/// Scope: this checks only `kernel.wasm`, the one artifact in
/// `local-binaries/source-only-v1/` that carries an `__abi_version` export
/// (`crates/kernel/src/wasm_api.rs`'s `__abi_version() -> u32`). That is the
/// literal filename the local-build engine writes and the resolver's
/// `source-only-v1` tier requests (`candidatesFor` in `binary-resolver.ts`
/// resolves the raw `kernel.wasm` relPath, unadjusted) — `kandelo-kernel.wasm`
/// was the old `build.sh`-era name in the ambient `local-binaries/` tier,
/// which Stage 1 stopped producing. The other artifacts the tier's
/// default-policy priority now covers — everything under `programs/` — are
/// content-addressed generations the local-build engine keys by cache key
/// derived from their own inputs (ABI included, where an artifact's build
/// depends on it). A stale input there is a cache-key mismatch that already
/// forces a rebuild through the normal engine path, not a silent-staleness
/// hazard this freshness check needs to duplicate.
pub(crate) fn verify_fresh_report(repo: &Path) -> Result<(), String> {
    let kernel_path = repo
        .join("local-binaries")
        .join("source-only-v1")
        .join("kernel.wasm");
    let bytes = match fs::read(&kernel_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!("read {}: {error}", kernel_path.display()));
        }
    };
    let expected = wasm_posix_shared::ABI_VERSION;
    let declared = wasm_declared_abi_version(&bytes).map_err(|detail| {
        format!("{}: {detail}", kernel_path.display())
    })?
    .ok_or_else(|| {
        format!(
            "{}: kernel.wasm has no __abi_version export",
            kernel_path.display()
        )
    })?;
    if declared != expected {
        return Err(format!(
            "{} is stale: kernel.wasm declares ABI {declared}, but the \
             source tree now builds ABI {expected}. Rebuild with `./run.sh setup` \
             (or `cargo xtask bootstrap`).",
            kernel_path.display()
        ));
    }
    // Same-ABI staleness backstop (B1). The ABI-version check above only
    // catches cross-ABI staleness; an internal kernel change that keeps
    // `ABI_VERSION` still moves the SourceOnlyV1 cache key the build engine
    // stamps onto `kernel.wasm`. So the staged kernel must carry the exact key
    // its current source resolves to -- a stale mirror's stamp no longer
    // matches (or is absent) and fails loud here instead of letting a test
    // suite run against yesterday's kernel.
    //
    // Read the stamp before recomputing the expected key: an unstamped
    // artifact is unverifiable regardless of the source tree, so report that
    // directly without the (comparatively expensive) SourceOnlyV1 resolve.
    let stamp = crate::build_stamp::read_build_key(&bytes)
        .map_err(|error| format!("{}: {error}", kernel_path.display()))?;
    let Some(stamp) = stamp else {
        return Err(format!(
            "{} carries no build key stamp; rebuild with `./run.sh setup` \
             so freshness can be verified.",
            kernel_path.display()
        ));
    };
    let expected_key = expected_source_only_cache_key(repo, "kernel")?;
    if stamp != expected_key {
        return Err(format!(
            "{} is stale: it was built for key {}, but the current source \
             tree resolves to key {}. Rebuild with `./run.sh setup` (or \
             `cargo xtask bootstrap`).",
            kernel_path.display(),
            crate::util::hex(&stamp),
            crate::util::hex(&expected_key),
        ));
    }
    // B3: the ABI-version check and the build-key backstop above both prove
    // the staged kernel.wasm matches the current source tree. Neither one
    // proves the committed abi/snapshot.json (a separate tracked artifact,
    // consumed by CI's structural-compat gate) still matches those same
    // sources -- so run that check too, gated to keep the local no-op path
    // fast.
    snapshot_drift_check(repo, false)?;
    Ok(())
}

/// Fail loud if the committed `abi/snapshot.json` has drifted from its
/// sources. Invokes `check-abi-version.sh check` (regenerate-in-memory-and-
/// compare) -- it never runs `update`, so the tracked file is never
/// overwritten by this call. `force` bypasses the mtime gate below; real
/// callers (`verify_fresh_report`) pass `false` so an unrelated `verify-
/// fresh` run does not pay for a kernel rebuild + dump-abi pass.
///
/// CI runs `check-abi-version.sh check` unconditionally through its own
/// workflow regardless of this gate: a fresh checkout has meaningless
/// relative mtimes, so CI cannot rely on the same shortcut. This gate only
/// spares the LOCAL no-op path when nothing ABI-relevant changed.
pub(crate) fn snapshot_drift_check(repo: &Path, force: bool) -> Result<(), String> {
    if !force && !abi_sources_changed_since_snapshot(repo)? {
        return Ok(());
    }
    run_check_abi_version_check(repo, "scripts/check-abi-version.sh")
}

/// Run `bash <repo>/<script_rel> check` and map a non-zero exit to a loud,
/// actionable error. Split out from `snapshot_drift_check` so tests can
/// substitute a stub script to exercise the exit-code-to-error mapping
/// without ever invoking the real `check-abi-version.sh`, which builds the
/// kernel and requires a real git checkout.
fn run_check_abi_version_check(repo: &Path, script_rel: &str) -> Result<(), String> {
    let script = repo.join(script_rel);
    let status = Command::new("bash")
        .arg(&script)
        .arg("check")
        .current_dir(repo)
        .status()
        .map_err(|error| format!("run {}: {error}", script.display()))?;
    if !status.success() {
        return Err(
            "the ABI-snapshot freshness check did not pass (either abi/snapshot.json \
             drifted from its sources, or the check could not run -- see the check \
             output above). If it drifted, run \
             `bash scripts/check-abi-version.sh update` and commit the result."
                .to_string(),
        );
    }
    Ok(())
}

/// Cheap gate for `snapshot_drift_check`: has any ABI-defining source
/// changed more recently than the committed snapshot? Compares
/// `abi/snapshot.json`'s mtime against the newest mtime found under
/// `crates/shared` and `crates/kernel`. This is a gate, not the safety
/// check itself -- a false "changed" only costs one extra
/// `check-abi-version.sh` run -- so ambiguity resolves to `true`: a
/// missing snapshot, or an error walking a source directory that does
/// exist, both return `true` (run the check) rather than silently
/// skipping it.
fn abi_sources_changed_since_snapshot(repo: &Path) -> Result<bool, String> {
    let snapshot = repo.join("abi/snapshot.json");
    let snapshot_mtime = match fs::metadata(&snapshot).and_then(|meta| meta.modified()) {
        Ok(mtime) => mtime,
        Err(_) => return Ok(true),
    };
    for dir in ["crates/shared", "crates/kernel"] {
        match newest_mtime_under(&repo.join(dir)) {
            Ok(mtime) if mtime > snapshot_mtime => return Ok(true),
            Ok(_) => {}
            // A read error inside a directory that DOES exist (permission
            // denied, a symlink that can't be stat'd, etc) is ambiguity
            // unrelated to ABI drift, not proof of "nothing changed." Open
            // the gate and let the authoritative `check-abi-version.sh`
            // run rather than propagating the error and failing the whole
            // pre-test gate on something that has nothing to do with the
            // ABI snapshot.
            Err(_) => return Ok(true),
        }
    }
    Ok(false)
}

/// Newest file mtime found anywhere under `dir`, walked recursively. A
/// `dir` that does not exist at all contributes no files, so it returns
/// `SystemTime::UNIX_EPOCH` rather than an error: the real repo always has
/// `crates/shared` and `crates/kernel`, so this only matters for synthetic
/// test fixtures that do not materialize the whole tree. An error reading
/// an entry inside a directory that DOES exist is real ambiguity and is
/// propagated, which `abi_sources_changed_since_snapshot` maps to the
/// conservative "run the check" outcome.
fn newest_mtime_under(dir: &Path) -> Result<SystemTime, String> {
    if !dir.exists() {
        return Ok(SystemTime::UNIX_EPOCH);
    }
    let mut newest = SystemTime::UNIX_EPOCH;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = fs::read_dir(&current)
            .map_err(|error| format!("read_dir {}: {error}", current.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!("read_dir entry under {}: {error}", current.display())
            })?;
            let file_type = entry.file_type().map_err(|error| {
                format!("file_type {}: {error}", entry.path().display())
            })?;
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map_err(|error| format!("mtime {}: {error}", entry.path().display()))?;
            if modified > newest {
                newest = modified;
            }
        }
    }
    Ok(newest)
}

/// Recompute the SourceOnlyV1 cache key `package` currently resolves to -- the
/// same key `build_into_cache` stamps onto the package's published wasm output.
/// `verify_fresh_report` compares this against the staged kernel's stamp, so a
/// stale mirror (older stamp, or none) fails loud. Reuses the build engine's
/// own key function (`build_deps::source_only_cache_key_sha`) rather than
/// recomputing, so the expected key can never drift from what a real build
/// stamps.
pub(crate) fn expected_source_only_cache_key(
    repo: &Path,
    package: &str,
) -> Result<[u8; 32], String> {
    let registry = fixed_registry(repo);
    let manifest = registry.load(package)?;
    let sha = crate::build_deps::source_only_cache_key_sha(
        &manifest,
        &registry,
        TargetArch::Wasm32,
        wasm_posix_shared::ABI_VERSION,
    )?;
    crate::util::hex_to_32(&sha)
}

/// Walk REVERSE edges over `graph.dependencies` (which maps a node to the
/// set of nodes *it* depends on) to find every node that depends on `node`,
/// directly or transitively — i.e. everything cleaning `node` invalidates.
/// The returned set always includes `node` itself.
///
/// This replaces the hand-written "also invalidated shell.vfs.zst" warnings
/// `run.sh`'s old `clean_target` hardcoded per package: the dependency graph
/// already knows which products embed a given package (e.g. `nethack` is
/// pulled in by `nethack-browser-bundle`, which `shell` depends on, which the
/// `browser-main-shell` product maps to), so the cascade is derived instead
/// of maintained by hand.
///
/// `O(removed * graph size)` — fine at this repo's scale (dozens of packages,
/// a handful of products), and simple enough to trust over a fancier
/// reverse-adjacency index that would need to be kept in sync with
/// `dependencies` by construction.
pub(crate) fn clean_removal_set(
    graph: &PlannedGraphV1,
    node: &PlanNodeV1,
) -> BTreeSet<PlanNodeV1> {
    let mut removal = BTreeSet::new();
    removal.insert(node.clone());
    let mut frontier = vec![node.clone()];
    while let Some(current) = frontier.pop() {
        for (candidate, deps) in &graph.dependencies {
            if deps.contains(&current) && removal.insert(candidate.clone()) {
                frontier.push(candidate.clone());
            }
        }
    }
    removal
}

/// Resolve a bare `xtask clean <target>` positional to the graph node it
/// names: a declared VFS product id, or a package name (tried against every
/// architecture the graph actually planned for it). Unlike
/// `bootstrap_target_to_selection`, there is no host-step carve-out here —
/// `clean` only ever operates on graph nodes with resolver-owned outputs;
/// non-graph host/toolchain state (`sysroot`, `sdk`, cargo's own
/// `target/`, ...) is still `run.sh`'s responsibility.
fn resolve_clean_target(graph: &PlannedGraphV1, target: &str) -> Result<PlanNodeV1, String> {
    let product = PlanNodeV1::product(target);
    if graph.dependencies.contains_key(&product) {
        return Ok(product);
    }
    let wasm32 = PlanNodeV1::package(target, "wasm32");
    if graph.dependencies.contains_key(&wasm32) {
        return Ok(wasm32);
    }
    // `./run.sh clean mariadb64` names the wasm64 build of the `mariadb`
    // package; the package graph has no node literally named "mariadb64".
    // Strip the historical "64" suffix convention `select_graph_dependencies`
    // already uses for the same target strings in `bootstrap`/`build`.
    if let Some(base) = target.strip_suffix("64") {
        let wasm64 = PlanNodeV1::package(base, "wasm64");
        if graph.dependencies.contains_key(&wasm64) {
            return Ok(wasm64);
        }
    }
    let wasm64 = PlanNodeV1::package(target, "wasm64");
    if graph.dependencies.contains_key(&wasm64) {
        return Ok(wasm64);
    }
    Err(format!(
        "clean: {target:?} is not a package or product in packages/sets/local-supported.toml \
         (the local-build graph); it is not something `xtask clean` can resolve"
    ))
}

/// Remove every on-disk trace of one compiled `SourceOnlyV1` package-node
/// generation: its canonical content-addressed cache directory, the hidden
/// receipt sidecar next to it, and (read straight from that receipt, before
/// deleting it) the files it mirrored into `output_root`. Matches by name/
/// version/revision/arch prefix rather than the current content hash, so a
/// clean sweeps every generation ever cached for this node — not just the one
/// matching today's source tree — the same way `rm -rf` would.
fn clean_package_node_outputs(
    registry: &Registry,
    compiled_cache_root: &Path,
    output_root: &Path,
    name: &str,
    target_arch: &str,
) -> Result<Vec<PathBuf>, String> {
    let manifest = registry.load(name)?;
    let kind_subdir = match manifest.kind {
        ManifestKind::Source => "sources",
        ManifestKind::Library => "libs",
        ManifestKind::Program => "programs",
    };
    let prefix = match manifest.kind {
        ManifestKind::Source => format!("{}-{}-rev{}-", manifest.name, manifest.version, manifest.revision),
        ManifestKind::Library | ManifestKind::Program => format!(
            "{}-{}-rev{}-{}-",
            manifest.name, manifest.version, manifest.revision, target_arch
        ),
    };
    let dir = compiled_cache_root.join(kind_subdir);
    let mut removed = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(removed),
        Err(error) => return Err(format!("read {}: {error}", dir.display())),
    };
    let mut matches = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("read {}: {error}", dir.display()))?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if let Some(cache_key_sha) = file_name.strip_prefix(prefix.as_str()) {
            matches.push((entry.path(), cache_key_sha.to_string()));
        }
    }
    matches.sort();
    for (canonical, cache_key_sha) in matches {
        if let Ok(Some(receipt)) = read_source_only_cache_receipt(&canonical, &cache_key_sha) {
            for member in &receipt.materialized_members {
                let mirrored = output_root.join(&member.mirror_path);
                match fs::remove_file(&mirrored) {
                    Ok(()) => removed.push(mirrored),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!("remove {}: {error}", mirrored.display()));
                    }
                }
            }
        }
        if let Ok(receipt_path) = source_only_cache_receipt_path(&canonical, &cache_key_sha) {
            match fs::remove_file(&receipt_path) {
                Ok(()) => removed.push(receipt_path),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("remove {}: {error}", receipt_path.display()));
                }
            }
        }
        fs::remove_dir_all(&canonical)
            .map_err(|error| format!("remove {}: {error}", canonical.display()))?;
        removed.push(canonical);
    }
    Ok(removed)
}

/// Remove the one on-disk artifact a VFS product node owns that its mapped
/// package node's cache/mirror does not already cover: the legacy
/// `apps/browser-demos/public/<output>` copy. A product's actual build/cache
/// decision is entirely the mapped package's (see `PlanNodeV1::Product`
/// handling in `run_node`), so invalidating the product's cascade entry in
/// `clean_removal_set` is really about invalidating that mapped package —
/// which `clean_package_node_outputs` already does when the package node
/// also appears in the removal set (it always does; every product's mapped
/// package is a direct dependency edge).
fn clean_product_node_outputs(
    repo: &Path,
    graph: &PlannedGraphV1,
    id: &str,
) -> Result<Vec<PathBuf>, String> {
    let entry = graph
        .plan
        .products
        .iter()
        .find(|product| product.id == id)
        .ok_or_else(|| format!("clean: product {id:?} is missing from the resolved plan"))?;
    let manifest_path = repo.join(&entry.manifest);
    let bytes = fs::read(&manifest_path)
        .map_err(|error| format!("read {}: {error}", manifest_path.display()))?;
    let manifest = parse_product_manifest_bytes(repo, &manifest_path, &bytes)?;
    let public_asset = repo.join("apps/browser-demos/public").join(&manifest.output);
    let mut removed = Vec::new();
    match fs::remove_file(&public_asset) {
        Ok(()) => removed.push(public_asset),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("remove {}: {error}", public_asset.display())),
    }
    Ok(removed)
}

/// `xtask clean <target>` — resolve `<target>` to a package or product node
/// in the local-build graph, derive the full cascade of nodes it invalidates
/// via `clean_removal_set`, remove every node's on-disk cache/mirror/product
/// artifacts, and print the derived cascade so a caller sees exactly what
/// else was invalidated (instead of a static hand-written warning).
///
/// Removing the compiled cache entry (and its receipt sidecar) for every
/// node in the cascade is what makes a subsequent `./run.sh build <target>`
/// (unforced, ordinary cache-consulting build) do a genuine rebuild rather
/// than reporting `cached`: `source_only_skip_receipt_if_clean` treats an
/// absent cache entry as an unconditional cache miss.
pub(crate) fn run_clean(args: Vec<String>) -> Result<(), String> {
    let target = match args.as_slice() {
        [target] if !target.starts_with("--") => target.clone(),
        _ => return Err("usage: xtask clean <target>".to_string()),
    };

    let repo = crate::repo_root();
    let set = repo.join("packages/sets/local-supported.toml");
    let registry = fixed_registry(&repo);
    let graph = load_and_plan(&repo, &set, &registry)?;
    let node = resolve_clean_target(&graph, &target)?;
    let removal = clean_removal_set(&graph, &node);

    let compiled_cache_root =
        plan_canonical_source_only_cache_roots(&default_source_cache_root()?, None)?.compiled;
    let output_root = repo.join("local-binaries/source-only-v1");

    let mut removed_paths = Vec::new();
    for cleaned in &removal {
        match cleaned {
            PlanNodeV1::Package { name, target_arch } => {
                removed_paths.extend(clean_package_node_outputs(
                    &registry,
                    &compiled_cache_root,
                    &output_root,
                    name,
                    target_arch,
                )?);
            }
            PlanNodeV1::Product { id } => {
                removed_paths.extend(clean_product_node_outputs(&repo, &graph, id)?);
            }
        }
    }

    println!("Cleaned {}", node_label(&node));
    for path in &removed_paths {
        println!("  removed {}", path.display());
    }
    let cascade: Vec<&PlanNodeV1> = removal.iter().filter(|other| *other != &node).collect();
    if !cascade.is_empty() {
        println!(
            "Also invalidated ({} depends on / embeds {}):",
            if cascade.len() == 1 { "this" } else { "these" },
            node_label(&node)
        );
        for other in cascade {
            println!("  {}", node_label(other));
        }
    }
    Ok(())
}

/// Extract the ABI version a wasm module declares via its `__abi_version`
/// export. Mirrors the "constant" extraction shape in
/// `wasm_extract_abi_version`/`_wasm_extract_constant_i32_body` in
/// `scripts/wasm-artifact-guards.sh`: the exported function's body must be
/// exactly `i32.const <N> end` or `i32.const <N> return end`. Returns `Ok(None)`
/// only when the module genuinely has no such export; every inspection or
/// shape failure is an `Err` so this stays fail-closed like its shell
/// counterpart.
fn wasm_declared_abi_version(bytes: &[u8]) -> Result<Option<u32>, String> {
    use wasmparser::{ExternalKind, Imports, Operator, Parser, Payload, TypeRef};

    let mut imported_funcs: u32 = 0;
    let mut export_func_index: Option<u32> = None;
    let mut code_bodies: Vec<wasmparser::FunctionBody<'_>> = Vec::new();

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = payload.map_err(|error| format!("parse wasm: {error}"))?;
        match payload {
            Payload::ImportSection(reader) => {
                // Three import-group encodings in wasmparser 0.247, matching
                // `kernel_exports` in dump_abi.rs. Only `Single` appears in
                // stock LLVM output; the `Compact*` variants come from the
                // compact-imports proposal and are handled for completeness.
                for group in reader {
                    let group = group.map_err(|error| format!("import section: {error}"))?;
                    match group {
                        Imports::Single(_, import) => {
                            if matches!(import.ty, TypeRef::Func(_)) {
                                imported_funcs += 1;
                            }
                        }
                        Imports::Compact1 { items, .. } => {
                            for item in items {
                                let item = item.map_err(|error| format!("import section: {error}"))?;
                                if matches!(item.ty, TypeRef::Func(_)) {
                                    imported_funcs += 1;
                                }
                            }
                        }
                        Imports::Compact2 { ty, names, .. } => {
                            for name in names {
                                let _ = name.map_err(|error| format!("import section: {error}"))?;
                                if matches!(ty, TypeRef::Func(_)) {
                                    imported_funcs += 1;
                                }
                            }
                        }
                    }
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export.map_err(|error| format!("export section: {error}"))?;
                    if export.name == "__abi_version" && export.kind == ExternalKind::Func {
                        export_func_index = Some(export.index);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                code_bodies.push(body);
            }
            _ => {}
        }
    }

    let Some(export_func_index) = export_func_index else {
        return Ok(None);
    };
    let local_index = export_func_index.checked_sub(imported_funcs).ok_or_else(|| {
        "__abi_version export index is inside the imported function range".to_string()
    })?;
    let body = code_bodies.get(local_index as usize).ok_or_else(|| {
        "__abi_version export has no matching function body".to_string()
    })?;
    let mut operators = body
        .get_operators_reader()
        .map_err(|error| format!("read __abi_version function body: {error}"))?;
    let malformed = || {
        "__abi_version function body is not a plain `i32.const <N> [return] end` constant"
            .to_string()
    };

    let first = operators
        .read()
        .map_err(|error| format!("read __abi_version function body: {error}"))?;
    let Operator::I32Const { value } = first else {
        return Err(malformed());
    };
    let second = operators
        .read()
        .map_err(|error| format!("read __abi_version function body: {error}"))?;
    let terminated = match second {
        Operator::End => true,
        Operator::Return => {
            let third = operators
                .read()
                .map_err(|error| format!("read __abi_version function body: {error}"))?;
            matches!(third, Operator::End)
        }
        _ => false,
    };
    if !terminated {
        return Err(malformed());
    }
    u32::try_from(value)
        .map(Some)
        .map_err(|_| format!("__abi_version constant {value} is not a valid u32"))
}

fn run_plan(set: PathBuf) -> Result<(), String> {
    let repo = crate::repo_root();
    let set = resolve_repo_file(&repo, &set, "supported set")?;
    let registry = fixed_registry(&repo);
    let graph = load_and_plan(&repo, &set, &registry)?;
    let bytes = canonical_plan_bytes(&graph.plan)?;
    std::io::Write::write_all(&mut std::io::stdout().lock(), &bytes)
        .map_err(|error| format!("write local-build plan: {error}"))
}

fn fixed_registry(repo: &Path) -> Registry {
    Registry {
        roots: vec![repo.join("packages/registry")],
    }
}

static LOCAL_BUILD_RUN_COUNTER: AtomicU64 = AtomicU64::new(0);
static LOCAL_BUILD_RESULT_COUNTER: AtomicU64 = AtomicU64::new(0);

fn package_projection_is_eligible(
    selected: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    results: &[NodeRunResultV1],
) -> bool {
    let terminal = results
        .iter()
        .map(|result| match result {
            NodeRunResultV1::Succeeded { node, .. } => (node, true),
            NodeRunResultV1::Failed { node, .. } | NodeRunResultV1::Blocked { node, .. } => {
                (node, false)
            }
        })
        .collect::<BTreeMap<_, _>>();
    selected.keys().all(|node| {
        !matches!(node, PlanNodeV1::Package { .. }) || terminal.get(node) == Some(&true)
    })
}

/// Emit the derived VFS product catalog
/// (`images/vfs/products/generated/catalog.json`) from the committed product
/// manifests before any build node runs. The catalog is a generated artifact
/// (gitignored, like every other build output): browser demos and the VFS
/// image builder consume it, so every local build regenerates it to keep it
/// current with the manifests it is derived from.
fn generate_vfs_product_catalog(repo: &Path) -> Result<(), String> {
    let product_dir = repo.join("images/vfs/products");
    write_or_check_product_catalog(
        CatalogWriteMode::Generate,
        repo,
        &product_dir,
        &product_dir.join("generated/catalog.json"),
    )
}

/// Emit the derived program package index
/// (`packages/registry/program-packages.json`) from the committed package
/// manifests before any build node runs. Like the VFS product catalog above,
/// the index is a generated artifact (gitignored, not committed): the TS
/// resolver, `scripts/build-programs.sh`, and the npm host package consume it,
/// so every local build regenerates it to keep it current with the manifests it
/// is derived from. `ensure_*` writes only when the projection has drifted, so
/// an already-current index is left untouched.
fn generate_program_package_index(repo: &Path) -> Result<(), String> {
    crate::build_deps::ensure_program_package_indexes_in_context(&fixed_registry(repo))
}

/// Whether the on-disk source-only program projection authority already records
/// the given graph authority. When every node is unchanged and this holds, a
/// no-op can leave the published projection in place instead of re-deriving and
/// re-publishing an identical one.
fn source_only_program_projection_is_current(
    output_root: &Path,
    expected_graph_authority_sha256: &str,
) -> bool {
    let path = output_root
        .join(".kandelo")
        .join("source-only-program-projection-v1.json");
    let Ok(bytes) = fs::read(&path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    value
        .get("graphAuthoritySha256")
        .and_then(|recorded| recorded.as_str())
        .map(|recorded| recorded == expected_graph_authority_sha256)
        .unwrap_or(false)
}

/// Identify compiled package nodes whose content-addressed cache entry, receipt
/// sidecar, and projected outputs are all present, so the scheduler can report
/// them `Cached` without launching a child process. A node's cache key folds its
/// transitive dependency keys, so any change to its inputs makes it (and its
/// dependents) miss and fall back to a child build. Only compiled package nodes
/// are considered here; product and source nodes always run their child.
#[cfg(unix)]
fn parse_node_target_arch(target_arch: &str) -> Option<TargetArch> {
    match target_arch {
        "wasm32" => Some(TargetArch::Wasm32),
        "wasm64" => Some(TargetArch::Wasm64),
        _ => None,
    }
}

/// The value stored per skippable node: `Some(receipt)` for a compiled package
/// (which the projection finalizer needs a receipt for), `None` for a product
/// (which only validates its mapped package and carries no receipt).
#[cfg(unix)]
fn compute_skip_receipts(
    registry: &Registry,
    graph: &PlannedGraphV1,
    selected: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    cache_roots: &SourceOnlyCacheRoots,
    output_root: &Path,
) -> BTreeMap<PlanNodeV1, Option<PackageNodeReceiptV1>> {
    let mut memo = BTreeMap::new();
    let mut skip = BTreeMap::new();
    for node in selected.keys() {
        match node {
            PlanNodeV1::Package { name, target_arch } => {
                let Some(arch) = parse_node_target_arch(target_arch) else {
                    continue;
                };
                let Ok(manifest) = registry.load(name) else {
                    continue;
                };
                if manifest.kind == ManifestKind::Source
                    || !manifest.target_arches.contains(&arch)
                {
                    continue;
                }
                if let Some(receipt) = source_only_skip_receipt_if_clean(
                    &manifest,
                    registry,
                    arch,
                    wasm_posix_shared::ABI_VERSION,
                    cache_roots,
                    output_root,
                    &mut memo,
                ) {
                    skip.insert(node.clone(), Some(receipt));
                }
            }
            PlanNodeV1::Product { id } => {
                // A product's child only resolves and validates its mapped
                // package (it builds no image), so an unchanged mapped package
                // makes the product a no-op. Products carry no receipt.
                let Some(retained) = graph.product_execution.get(id) else {
                    continue;
                };
                let Some(arch) = parse_node_target_arch(&retained.binding.target_arch) else {
                    continue;
                };
                let Ok(manifest) = registry.load(&retained.binding.mapped_package) else {
                    continue;
                };
                if manifest.kind != ManifestKind::Program
                    || !manifest.target_arches.contains(&arch)
                {
                    continue;
                }
                if source_only_skip_receipt_if_clean(
                    &manifest,
                    registry,
                    arch,
                    wasm_posix_shared::ABI_VERSION,
                    cache_roots,
                    output_root,
                    &mut memo,
                )
                .is_some()
                {
                    skip.insert(node.clone(), None);
                }
            }
        }
    }
    skip
}

#[cfg(not(unix))]
fn compute_skip_receipts(
    _registry: &Registry,
    _graph: &PlannedGraphV1,
    _selected: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    _cache_roots: &SourceOnlyCacheRoots,
    _output_root: &Path,
) -> BTreeMap<PlanNodeV1, Option<PackageNodeReceiptV1>> {
    BTreeMap::new()
}

fn run_aggregate(args: LocalBuildRunArgsV1) -> Result<(), String> {
    let repo = canonical_real_directory(&crate::repo_root(), "local-build repository root")?;
    generate_vfs_product_catalog(&repo)?;
    generate_program_package_index(&repo)?;
    let set = resolve_repo_file(&repo, &args.set, "supported set")?;
    let set = fs::canonicalize(&set)
        .map_err(|error| format!("canonicalize supported set {}: {error}", set.display()))?;
    let registry = fixed_registry(&repo);
    let graph = load_and_plan(&repo, &set, &registry)?;
    let selected = select_graph_dependencies(&graph, &args.products)?;

    let planned_cache = plan_canonical_source_only_cache_roots(&args.source_cache_root, None)?;
    let output_intended = canonicalize_with_missing_tail(&args.output_root)?;
    validate_run_roots(&repo, &set, &planned_cache.base, &output_intended)?;
    let cache_roots = materialize_planned_source_only_cache_roots(&planned_cache)?;
    fs::create_dir_all(&output_intended).map_err(|error| {
        format!(
            "create local-build output root {}: {error}",
            output_intended.display()
        )
    })?;
    let output_root = exact_canonical_directory(&output_intended, "local-build output root")?;
    validate_run_roots(&repo, &set, &cache_roots.base, &output_root)?;

    // Build/refresh the co-resident fork-module PIC side modules (Phase 6 D5)
    // before finalization so they can be projected as owned members. build-wasm.sh
    // owns the build + closure-derived freshness stamp; this only invokes it.
    ensure_coresident_fork_module_built(&repo)?;

    let run_directory = create_run_directory(&output_root)?;
    let mut result_paths = BTreeMap::new();
    for (index, node) in selected.keys().enumerate() {
        result_paths.insert(
            node.clone(),
            run_directory.join(format!("node-{index}.json")),
        );
    }
    let receipt_requirements = selected
        .keys()
        .filter_map(|node| match node {
            PlanNodeV1::Package { name, .. } => Some(
                registry
                    .load(name)
                    .map(|manifest| (node.clone(), manifest.kind != ManifestKind::Source)),
            ),
            PlanNodeV1::Product { .. } => None,
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let expected_receipt_nodes = receipt_requirements
        .iter()
        .filter_map(|(node, required)| required.then_some(node.clone()))
        .collect::<BTreeSet<_>>();
    let retained_receipts = Arc::new(Mutex::new(BTreeMap::<
        PlanNodeV1,
        PackageNodeReceiptV1,
    >::new()));

    let color = ansi_enabled(
        std::io::IsTerminal::is_terminal(&std::io::stderr()),
        std::env::var_os("NO_COLOR").is_some(),
    );
    let mut aggregate_failed = false;
    let launcher_result_paths = result_paths.clone();
    let launcher_receipt_requirements = receipt_requirements.clone();
    let launcher_receipts = Arc::clone(&retained_receipts);
    let rebuild = args.rebuild;
    let verify_cache = args.verify_cache;
    // Report unchanged compiled package nodes Cached without launching a child.
    // `--rebuild` forces every node; `--verify-cache` re-verifies every entry, so
    // both disable the skip.
    let skip_receipts = if args.rebuild || args.verify_cache {
        BTreeMap::new()
    } else {
        compute_skip_receipts(&registry, &graph, &selected, &cache_roots, &output_root)
    };
    let skip_receipts = Arc::new(skip_receipts);
    let results = execute_graph_with_events(
        &selected,
        args.jobs,
        {
            let repo = repo.clone();
            let set = set.clone();
            let source_cache_root = cache_roots.base.clone();
            let compiled_cache_root = cache_roots.compiled.clone();
            let output_root = output_root.clone();
            let authority_sha256 = graph.authority_sha256.clone();
            let retained_receipts = Arc::clone(&launcher_receipts);
            let skip_receipts = Arc::clone(&skip_receipts);
            move |node, completions| {
                if let Some(entry) = skip_receipts.get(&node) {
                    // Unchanged node: report Cached without a child process. A
                    // compiled package records its persisted receipt (the
                    // projection finalizer validates it exactly as it would a
                    // child-produced one); a product carries no receipt.
                    let completion = match entry {
                        Some(receipt) => match retained_receipts.lock() {
                            Ok(mut retained) => {
                                if retained.insert(node.clone(), receipt.clone()).is_some() {
                                    eprintln!(
                                        "[{}] scheduler failure: duplicate skipped package receipt",
                                        node_label(&node),
                                    );
                                    NodeCompletionV1::failed(node.clone(), None)
                                } else {
                                    NodeCompletionV1::succeeded(
                                        node.clone(),
                                        SuccessDispositionV1::Cached,
                                    )
                                }
                            }
                            Err(_) => {
                                eprintln!(
                                    "[{}] scheduler failure: retained package-receipt store was poisoned",
                                    node_label(&node),
                                );
                                NodeCompletionV1::failed(node.clone(), None)
                            }
                        },
                        None => {
                            NodeCompletionV1::succeeded(node.clone(), SuccessDispositionV1::Cached)
                        }
                    };
                    let _ = completions.send(completion);
                    return Ok(());
                }
                let result_json = launcher_result_paths[&node].clone();
                let receipt_required = launcher_receipt_requirements
                    .get(&node)
                    .copied()
                    .unwrap_or(false);
                let repo = repo.clone();
                let set = set.clone();
                let source_cache_root = source_cache_root.clone();
                let compiled_cache_root = compiled_cache_root.clone();
                let output_root = output_root.clone();
                let authority_sha256 = authority_sha256.clone();
                let retained_receipts = Arc::clone(&retained_receipts);
                std::thread::spawn(move || {
                    let validated = run_child_process(
                        &repo,
                        &set,
                        &authority_sha256,
                        &source_cache_root,
                        &compiled_cache_root,
                        &output_root,
                        &node,
                        &result_json,
                        rebuild,
                        verify_cache,
                        receipt_required,
                    );
                    let completion = match validated {
                        Ok(validated) => {
                            let completion = validated.completion;
                            if let Some(receipt) = validated.package_receipt {
                                let retained = retained_receipts.lock().map_err(|_| {
                                    "retained package-receipt store was poisoned".to_string()
                                });
                                match retained {
                                    Ok(mut retained) => {
                                        if retained.insert(node.clone(), receipt).is_some() {
                                            eprintln!(
                                                "[{}] child protocol failure: duplicate retained package receipt",
                                                node_label(&node),
                                            );
                                            NodeCompletionV1::failed(node.clone(), None)
                                        } else {
                                            completion
                                        }
                                    }
                                    Err(error) => {
                                        eprintln!(
                                            "[{}] child protocol failure: {error}",
                                            node_label(&node),
                                        );
                                        NodeCompletionV1::failed(node.clone(), None)
                                    }
                                }
                            } else {
                                completion
                            }
                        }
                        Err(error) => {
                            eprintln!("[{}] child protocol failure: {error}", node_label(&node));
                            NodeCompletionV1::failed(node.clone(), None)
                        }
                    };
                    let _ = completions.send(completion);
                });
                Ok(())
            }
        },
        |event| render_scheduler_event(event, color, &mut aggregate_failed),
    )?;

    let retained_receipts = retained_receipts
        .lock()
        .map_err(|_| "retained package-receipt store was poisoned".to_string())?
        .clone();
    // Fully-clean no-op fast path: when the build succeeded, every compiled and
    // product node was reported cached by the up-front skip (nothing was built
    // or rebuilt), and the published projection already records this exact graph
    // authority, the finalizer would reproduce precisely what is already on
    // disk. Leave it in place instead of re-deriving and re-publishing it.
    // `--rebuild`/`--verify-cache` disable the skip, so this is unreachable then.
    let projection_up_to_date = package_projection_is_eligible(&selected, &results)
        && expected_receipt_nodes
            .iter()
            .all(|node| matches!(skip_receipts.get(node), Some(Some(_))))
        && selected
            .keys()
            .filter(|node| matches!(node, PlanNodeV1::Product { .. }))
            .all(|node| skip_receipts.contains_key(node))
        && source_only_program_projection_is_current(&output_root, &graph.authority_sha256)
        && coresident_fork_module_projection_is_current(&output_root, &repo);
    let projection_finalization_error = if projection_up_to_date {
        None
    } else if package_projection_is_eligible(&selected, &results) {
        finalize_source_only_program_projection(
            &repo,
            &set,
            &registry,
            &args.products,
            &selected,
            &graph.authority_sha256,
            &cache_roots,
            &output_root,
            &expected_receipt_nodes,
            &retained_receipts,
            args.verify_cache,
        )
        .err()
    } else {
        None
    };
    if let Some(error) = &projection_finalization_error {
        if !aggregate_failed {
            eprintln!("{}", render_projection_failure_banner(color));
        }
        eprintln!("source-only program authority finalization failed: {error}");
    }

    for path in result_paths.values() {
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!(
                "local-build warning: preserve result evidence {}: {error}",
                path.display()
            ),
        }
    }
    if let Err(error) = fs::remove_dir(&run_directory) {
        eprintln!(
            "local-build warning: preserve run directory {}: {error}",
            run_directory.display()
        );
    }

    let outcome = if projection_finalization_error.is_none()
        && results
            .iter()
            .all(|result| matches!(result, NodeRunResultV1::Succeeded { .. }))
    {
        AggregateOutcomeV1::Succeeded
    } else {
        AggregateOutcomeV1::Failed
    };
    let result = LocalBuildRunResultV1 {
        schema: 1,
        policy: LOCAL_SUPPORTED_POLICY.to_string(),
        outcome,
        nodes: results,
    };
    let bytes = canonical_machine_json(&result)?;
    std::io::Write::write_all(&mut std::io::stdout().lock(), &bytes)
        .map_err(|error| format!("write local-build run result: {error}"))?;
    if outcome == AggregateOutcomeV1::Failed {
        Err("aggregate build failed after independent work drained".to_string())
    } else {
        Ok(())
    }
}

fn run_node(args: LocalBuildRunNodeArgsV1) -> Result<(), String> {
    validate_absent_result_target(&args.result_json)?;
    let node = args.node.clone();
    let execution = execute_admitted_node(&args);
    let envelope = match execution {
        Ok((disposition, package_receipt)) => NodeExecutionResultV1 {
            schema: 1,
            policy: LOCAL_SUPPORTED_POLICY.to_string(),
            result: NodeRunResultV1::Succeeded { node, disposition },
            package_receipt,
        },
        Err(error) => {
            let envelope = NodeExecutionResultV1 {
                schema: 1,
                policy: LOCAL_SUPPORTED_POLICY.to_string(),
                result: NodeRunResultV1::Failed {
                    node,
                    exit_code: Some(1),
                },
                package_receipt: None,
            };
            if let Err(write_error) = write_node_result_no_replace(&args.result_json, &envelope) {
                return Err(format!(
                    "{error}; additionally failed to publish child result: {write_error}"
                ));
            }
            return Err(error);
        }
    };
    write_node_result_no_replace(&args.result_json, &envelope)
}

fn execute_admitted_node(
    args: &LocalBuildRunNodeArgsV1,
) -> Result<(SuccessDispositionV1, Option<PackageNodeReceiptV1>), String> {
    let repo = exact_canonical_directory(&args.repo_root, "local-build repository root")?;
    let set = exact_canonical_regular_file(&args.set, "supported set")?;
    let source_cache_root =
        exact_canonical_directory(&args.source_cache_root, "source-only cache root")?;
    let compiled_cache_root =
        exact_canonical_directory(&args.compiled_cache_root, "source-only compiled cache root")?;
    let output_root = exact_canonical_directory(&args.output_root, "local-build output root")?;
    let planned_cache =
        plan_canonical_source_only_cache_roots(&source_cache_root, Some(&compiled_cache_root))?;
    if planned_cache.base != source_cache_root || planned_cache.compiled != compiled_cache_root {
        return Err(format!(
            "source-only cache pair changed during child admission: expected {{{}, {}}}, got {{{}, {}}}",
            source_cache_root.display(),
            compiled_cache_root.display(),
            planned_cache.base.display(),
            planned_cache.compiled.display(),
        ));
    }
    validate_run_roots(&repo, &set, &source_cache_root, &output_root)?;

    let _repo_root_override = crate::install_repo_root_override(repo.clone())?;
    let registry = fixed_registry(&repo);
    let graph = load_and_plan(&repo, &set, &registry)?;
    require_expected_graph_authority(&graph, &args.graph_authority_sha256)?;
    if !graph.dependencies.contains_key(&args.node) {
        return Err(format!(
            "requested node {} is absent from the admitted local-build graph",
            node_label(&args.node)
        ));
    }

    match &args.node {
        PlanNodeV1::Package { name, target_arch } => {
            let arch = match target_arch.as_str() {
                "wasm32" => TargetArch::Wasm32,
                "wasm64" => TargetArch::Wasm64,
                _ => {
                    return Err(format!(
                        "requested package node has unsupported architecture {target_arch:?}"
                    ));
                }
            };
            let manifest = registry.load(name)?;
            if !manifest.target_arches.contains(&arch) {
                return Err(format!(
                    "requested node {name}/{target_arch} is not declared by its package manifest"
                ));
            }
            let roots = SourceOnlyCacheRoots {
                base: source_cache_root,
                compiled: compiled_cache_root,
            };
            let expected_authority = args.graph_authority_sha256.clone();
            let mut before_projection =
                || require_current_graph_authority(&repo, &set, &expected_authority);
            let output = resolve_local_build_package_node_with_cache_policy(
                &manifest,
                &registry,
                arch,
                wasm_posix_shared::ABI_VERSION,
                &roots,
                &repo,
                &output_root,
                args.rebuild,
                args.verify_cache,
                &mut before_projection,
            )?;
            require_current_graph_authority(&repo, &set, &args.graph_authority_sha256)?;
            let receipt_required = manifest.kind != ManifestKind::Source;
            if receipt_required != output.package_receipt.is_some() {
                return Err(if receipt_required {
                    format!("{name}/{target_arch}: compiled node omitted its package receipt")
                } else {
                    format!(
                        "{name}/{target_arch}: source node returned a forbidden package receipt"
                    )
                });
            }
            Ok((
                success_disposition(output.disposition),
                output.package_receipt,
            ))
        }
        PlanNodeV1::Product { id } => {
            let retained = graph
                .product_execution
                .get(id)
                .ok_or_else(|| format!("product {id:?} has no retained execution authority"))?;
            if retained.binding.id != *id {
                return Err(format!(
                    "product {id:?} retained a mismatched execution binding {:?}",
                    retained.binding.id
                ));
            }
            let arch = match retained.binding.target_arch.as_str() {
                "wasm32" => TargetArch::Wasm32,
                "wasm64" => TargetArch::Wasm64,
                target_arch => {
                    return Err(format!(
                        "product {id:?} retained unsupported architecture {target_arch:?}"
                    ));
                }
            };
            if product_target_arch(retained.manifest.architecture) != arch {
                return Err(format!(
                    "product {id:?} retained architecture {:?} that differs from its manifest",
                    retained.binding.target_arch
                ));
            }
            let manifest = registry.load(&retained.binding.mapped_package)?;
            if manifest.kind != ManifestKind::Program {
                return Err(format!(
                    "product {id:?} maps to non-program package {:?}",
                    retained.binding.mapped_package
                ));
            }
            if !manifest.target_arches.contains(&arch) {
                return Err(format!(
                    "product {id:?} maps to package {:?} without architecture {:?}",
                    retained.binding.mapped_package, retained.binding.target_arch
                ));
            }
            let [mapped_output] = manifest.program_outputs.as_slice() else {
                return Err(format!(
                    "product {id:?} mapped package {:?} must declare exactly one output",
                    retained.binding.mapped_package
                ));
            };
            if mapped_output.wasm != retained.manifest.output {
                return Err(format!(
                    "product {id:?} output {:?} differs from mapped package output {:?}",
                    retained.manifest.output, mapped_output.wasm
                ));
            }
            let roots = SourceOnlyCacheRoots {
                base: source_cache_root,
                compiled: compiled_cache_root,
            };
            let expected_authority = args.graph_authority_sha256.clone();
            let mut before_projection =
                || require_current_graph_authority(&repo, &set, &expected_authority);
            let output = resolve_local_build_package_node_with_cache_policy(
                &manifest,
                &registry,
                arch,
                wasm_posix_shared::ABI_VERSION,
                &roots,
                &repo,
                &output_root,
                false,
                args.verify_cache,
                &mut before_projection,
            )?;
            require_current_graph_authority(&repo, &set, &args.graph_authority_sha256)?;
            if output.package_receipt.is_none() {
                return Err(format!(
                    "product {id:?} mapped package {:?} omitted its package receipt",
                    retained.binding.mapped_package
                ));
            }
            Ok((success_disposition(output.disposition), None))
        }
    }
}

fn success_disposition(disposition: LocalBuildDisposition) -> SuccessDispositionV1 {
    match disposition {
        LocalBuildDisposition::Cached => SuccessDispositionV1::Cached,
        LocalBuildDisposition::Published => SuccessDispositionV1::Published,
        LocalBuildDisposition::RebuiltEquivalent => SuccessDispositionV1::RebuiltEquivalent,
    }
}

fn require_expected_graph_authority(graph: &PlannedGraphV1, expected: &str) -> Result<(), String> {
    if graph.authority_sha256 != expected {
        return Err(format!(
            "local-build graph authority mismatch: expected {expected}, computed {}",
            graph.authority_sha256
        ));
    }
    Ok(())
}

fn require_current_graph_authority(repo: &Path, set: &Path, expected: &str) -> Result<(), String> {
    let registry = fixed_registry(repo);
    let current = load_and_plan(repo, set, &registry)?;
    require_expected_graph_authority(&current, expected)
}

fn selected_resolved_package_nodes(
    selected: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
) -> Result<BTreeSet<ResolvedDependencyNode>, String> {
    selected
        .keys()
        .filter_map(|node| match node {
            PlanNodeV1::Package { name, target_arch } => Some(match target_arch.as_str() {
                "wasm32" => Ok(ResolvedDependencyNode {
                    package_name: name.clone(),
                    target_arch: TargetArch::Wasm32,
                }),
                "wasm64" => Ok(ResolvedDependencyNode {
                    package_name: name.clone(),
                    target_arch: TargetArch::Wasm64,
                }),
                _ => Err(format!(
                    "selected package {name:?} has unsupported architecture {target_arch:?}"
                )),
            }),
            PlanNodeV1::Product { .. } => None,
        })
        .collect()
}

/// The name every co-resident fork-module projection node carries. It is not a
/// registry package (fork-module has no `packages/registry/<name>/build.toml`);
/// the name is a stable, single-path-component identity the projection consumer
/// admits as a root-level member alongside `kernel.wasm`.
const CORESIDENT_FORK_MODULE_NODE_NAME: &str = "fork-module";

/// The pointer-width co-resident fork-module wasm side modules
/// (`fork_module32.wasm` / `fork_module64.wasm`) are built out-of-band by
/// `crates/fork-module/build-wasm.sh` — a position-independent (`--pie`)
/// side-module `cargo build` (with `-Z build-std` plus a post-build walrus
/// injector) that the package resolver deliberately does not model (fork-module
/// carries no `build.toml`; see that script's header). Left unprojected they
/// resolve only through the ambient `local-binaries/` tier, which the browser's
/// SourceOnly Vite snapshot session cannot own — so a module-on browser build
/// fails its dep scan with "fork_module32.wasm is not owned by the pinned
/// SourceOnly projection" (`apps/browser-demos/source-only-vite-assets.ts`).
///
/// This projects them as first-class owned members of the source-only
/// projection, exactly like `kernel.wasm`, so every host (Node and the V8
/// browser) resolves the co-resident module through the same pinned projection
/// rather than an ambient copy. They are staged at the projection ROOT (their
/// host-visible resolver relPath is the unadjusted `fork_module{32,64}.wasm`),
/// each as its own single-member node so the consumer's root-level member rule
/// admits them next to `kernel.wasm`.
struct CoresidentForkModuleProjection {
    /// The fork-module cargo-closure digest that gates freshness, reused from
    /// `build-wasm.sh`'s build-key stamp (see
    /// `cargo_closure::workspace_crates_closure_sha`).
    closure_sha: String,
    members: Vec<MaterializedProgramMemberV1>,
}

/// Compute the co-resident fork-module projection members from the artifacts
/// `crates/fork-module/build-wasm.sh` stages into `local-binaries/`, verifying
/// each carries a build-key stamp matching the current fork-module cargo
/// closure. `fork_module32.wasm` is required; `fork_module64.wasm` mirrors the
/// build script's best-effort wasm64 policy (a tier-3 target) and is projected
/// only when present.
fn coresident_fork_module_projection(
    repo: &Path,
) -> Result<CoresidentForkModuleProjection, String> {
    let closure = crate::cargo_closure::workspace_crates_closure_sha(
        repo,
        &["fork-module".to_string(), "fork-module-inject".to_string()],
    )?;
    let closure_sha = crate::util::hex(&closure);
    let mut members = Vec::new();
    for width in [32u32, 64] {
        let name = format!("fork_module{width}.wasm");
        let artifact = repo.join("local-binaries").join(&name);
        if !artifact.is_file() {
            if width == 32 {
                return Err(format!(
                    "co-resident fork module {name} is missing from local-binaries; \
                     build it with `crates/fork-module/build-wasm.sh`"
                ));
            }
            // wasm64 is a tier-3 best-effort target in build-wasm.sh.
            continue;
        }
        let key_path = repo
            .join("local-binaries")
            .join(format!("{name}.build-key"));
        let stamped = fs::read_to_string(&key_path).map_err(|error| {
            format!(
                "co-resident fork module {name} carries no build-key stamp ({}): {error}; \
                 rebuild with `crates/fork-module/build-wasm.sh`",
                key_path.display()
            )
        })?;
        if stamped.trim() != closure_sha {
            return Err(format!(
                "co-resident fork module {name} is stale (build-key {}, current closure \
                 {closure_sha}); rebuild with `crates/fork-module/build-wasm.sh`",
                stamped.trim()
            ));
        }
        let bytes = fs::read(&artifact)
            .map_err(|error| format!("read {}: {error}", artifact.display()))?;
        members.push(MaterializedProgramMemberV1 {
            source_artifact: name.clone(),
            mirror_path: name.clone(),
            mode: 0o644,
            size: bytes.len() as u64,
            sha256: sha256_bytes(&bytes),
        });
    }
    members.sort_by(|left, right| {
        (&left.mirror_path, &left.source_artifact)
            .cmp(&(&right.mirror_path, &right.source_artifact))
    });
    Ok(CoresidentForkModuleProjection {
        closure_sha,
        members,
    })
}

/// One source-only projection node per co-resident fork-module width. Each is a
/// single root-level member so the consumer admits it under the same
/// root-level member rule as `kernel.wasm` (`binary-resolver.ts`).
fn coresident_fork_module_nodes(
    projection: &CoresidentForkModuleProjection,
) -> Vec<SourceOnlyProgramNodeV1> {
    projection
        .members
        .iter()
        .map(|member| {
            let target_arch = if member.mirror_path == "fork_module64.wasm" {
                "wasm64"
            } else {
                "wasm32"
            };
            // The node's manifest identity is a stable declaration tag (the
            // members ARE the artifacts, not a package manifest); its cache key
            // is the fork-module closure digest that gates freshness; its
            // receipt digest binds the projected member content.
            let manifest_sha256 = sha256_bytes(b"kandelo-coresident-fork-module-node-v1");
            let mut receipt = Sha256::new();
            receipt.update(b"kandelo-coresident-fork-module-receipt-v1\0");
            receipt.update((member.mirror_path.len() as u64).to_le_bytes());
            receipt.update(member.mirror_path.as_bytes());
            receipt.update(member.sha256.as_bytes());
            receipt.update(member.size.to_le_bytes());
            receipt.update((member.mode as u64).to_le_bytes());
            let cache_receipt_sha256 = crate::util::hex(&receipt.finalize());
            SourceOnlyProgramNodeV1 {
                node: SourceOnlyProgramNodeIdentityV1 {
                    kind: "package",
                    name: CORESIDENT_FORK_MODULE_NODE_NAME.to_string(),
                    target_arch: target_arch.to_string(),
                },
                manifest_sha256,
                cache_key_sha256: projection.closure_sha.clone(),
                cache_receipt_sha256,
                members: vec![member.clone()],
            }
        })
        .collect()
}

/// Stage the co-resident fork-module artifacts into the projection root so the
/// bytes the manifest records as members exist on disk (mirroring how the
/// per-node materialization stages `kernel.wasm`). Copies the freshness-verified
/// `local-binaries/` artifact and forces the recorded `0o644` mode so the
/// consumer's stable-read mode check matches.
fn stage_coresident_fork_module_members(
    repo: &Path,
    output_root: &Path,
    projection: &CoresidentForkModuleProjection,
) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    for member in &projection.members {
        let src = repo.join("local-binaries").join(&member.mirror_path);
        let dst = output_root.join(&member.mirror_path);
        fs::copy(&src, &dst)
            .map_err(|error| format!("stage {} -> {}: {error}", src.display(), dst.display()))?;
        fs::set_permissions(&dst, fs::Permissions::from_mode(member.mode))
            .map_err(|error| format!("chmod {}: {error}", dst.display()))?;
    }
    Ok(())
}

/// Ensure the co-resident fork-module side modules are built and stamped fresh
/// before the projection is finalized. Fast path: `--verify-fresh` skips the
/// (slower) `-Z build-std` build when the staged artifacts already match the
/// current fork-module cargo closure; only a stale/unstamped/missing artifact
/// triggers a rebuild. This is what makes `fork_module*.wasm` a build-pipeline
/// artifact instead of a manual side step.
fn ensure_coresident_fork_module_built(repo: &Path) -> Result<(), String> {
    let script = repo.join("crates/fork-module/build-wasm.sh");
    let fresh = Command::new("bash")
        .arg(&script)
        .arg("--verify-fresh")
        .current_dir(repo)
        .status()
        .map_err(|error| format!("spawn {} --verify-fresh: {error}", script.display()))?;
    if fresh.success() {
        return Ok(());
    }
    run_repo_script(repo, "crates/fork-module/build-wasm.sh", &[])
}

/// Whether the projection root already carries the current co-resident
/// fork-module artifacts byte-for-byte. Called only on the fully-clean no-op
/// fast path, after `ensure_coresident_fork_module_built` has refreshed the
/// `local-binaries/` copies, so a stale or missing projected copy (e.g. a
/// fork-module source change with an otherwise-unchanged package graph) forces
/// the finalizer to re-stage rather than leaving a stale module on disk.
fn coresident_fork_module_projection_is_current(output_root: &Path, repo: &Path) -> bool {
    for width in [32u32, 64] {
        let name = format!("fork_module{width}.wasm");
        let src = fs::read(repo.join("local-binaries").join(&name)).ok();
        let dst = fs::read(output_root.join(&name)).ok();
        match (width, src, dst) {
            // wasm64 is best-effort: an absent source must also be absent here.
            (64, None, None) => {}
            (_, Some(source), Some(projected)) if source == projected => {}
            _ => return false,
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn refreshed_source_only_program_projection(
    repo: &Path,
    set: &Path,
    registry: &Registry,
    product_filters: &[String],
    expected_selected: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    expected_graph_authority_sha256: &str,
    receipts: &BTreeMap<PlanNodeV1, PackageNodeReceiptV1>,
) -> Result<Vec<u8>, String> {
    let graph = load_and_plan(repo, set, registry)?;
    require_expected_graph_authority(&graph, expected_graph_authority_sha256)?;
    let selected = select_graph_dependencies(&graph, product_filters)?;
    if &selected != expected_selected {
        return Err(
            "selected local-build closure changed during program-authority finalization"
                .to_string(),
        );
    }
    let selected_nodes = selected_resolved_package_nodes(&selected)?;
    let projection = source_only_program_package_index_for_nodes(
        &repo.join("packages/registry"),
        registry,
        &selected_nodes,
        wasm_posix_shared::ABI_VERSION,
    )?;
    let root_mirror_nodes = selected
        .keys()
        .filter_map(|node| match node {
            PlanNodeV1::Package { name, .. } => Some(
                registry
                    .load(name)
                    .map(|manifest| manifest.uses_root_binary_mirror().then_some(node.clone())),
            ),
            PlanNodeV1::Product { .. } => None,
        })
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .collect::<BTreeSet<_>>();
    let mut authority = source_only_program_projection_candidate(
        projection,
        expected_graph_authority_sha256,
        receipts,
        &root_mirror_nodes,
    )?;
    // Project the co-resident fork-module side modules as owned root-level
    // members (built out-of-band by build-wasm.sh; see
    // `coresident_fork_module_projection`). Appended after the package-derived
    // candidate so the package receipt validation loop is untouched, then the
    // whole node set is re-sorted to preserve the consumer's (name, targetArch)
    // ordering invariant.
    let coresident = coresident_fork_module_projection(repo)?;
    for node in coresident_fork_module_nodes(&coresident) {
        if authority.nodes.iter().any(|existing| {
            existing.node.name == node.node.name
                && existing.node.target_arch == node.node.target_arch
        }) {
            return Err(format!(
                "co-resident fork-module node {}/{} collides with a package projection node",
                node.node.name, node.node.target_arch
            ));
        }
        authority.nodes.push(node);
    }
    authority.nodes.sort_by(|left, right| {
        (&left.node.name, &left.node.target_arch)
            .cmp(&(&right.node.name, &right.node.target_arch))
    });
    source_only_program_projection_bytes(&authority)
}

#[allow(clippy::too_many_arguments)]
fn finalize_source_only_program_projection(
    repo: &Path,
    set: &Path,
    registry: &Registry,
    product_filters: &[String],
    selected: &BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    graph_authority_sha256: &str,
    cache_roots: &SourceOnlyCacheRoots,
    output_root: &Path,
    expected_receipt_nodes: &BTreeSet<PlanNodeV1>,
    receipts: &BTreeMap<PlanNodeV1, PackageNodeReceiptV1>,
    verify_cache: bool,
) -> Result<(), String> {
    if receipts.keys().cloned().collect::<BTreeSet<_>>() != *expected_receipt_nodes {
        return Err(
            "retained package receipts do not exactly cover the successful compiled closure"
                .to_string(),
        );
    }

    let candidate = refreshed_source_only_program_projection(
        repo,
        set,
        registry,
        product_filters,
        selected,
        graph_authority_sha256,
        receipts,
    )?;
    // The co-resident fork-module members the candidate records are staged into
    // the projection root under the same lock, before the manifest goes live, so
    // the published authority never references bytes that are not yet on disk.
    let coresident = coresident_fork_module_projection(repo)?;
    with_source_only_program_projection_lock(output_root, |authority| {
        for node in expected_receipt_nodes {
            let PlanNodeV1::Package { name, target_arch } = node else {
                return Err("internal receipt set contains a product node".to_string());
            };
            let arch = match target_arch.as_str() {
                "wasm32" => TargetArch::Wasm32,
                "wasm64" => TargetArch::Wasm64,
                _ => {
                    return Err(format!(
                        "retained package {name:?} has unsupported architecture {target_arch:?}"
                    ));
                }
            };
            let manifest = registry.load(name)?;
            if manifest.kind == ManifestKind::Source {
                return Err(format!(
                    "source package {name:?} was incorrectly admitted to the compiled receipt set"
                ));
            }
            let receipt = receipts.get(node).ok_or_else(|| {
                format!("compiled package {name:?}/{target_arch} omitted its retained receipt")
            })?;
            authority.validate_package_receipt(
                &manifest,
                registry,
                cache_roots,
                arch,
                wasm_posix_shared::ABI_VERSION,
                verify_cache,
                receipt,
            )?;
        }

        stage_coresident_fork_module_members(repo, output_root, &coresident)?;

        if verify_cache {
            // Recompute the projection under the lock and confirm nothing moved
            // between the candidate and the publication boundary.
            let refreshed = refreshed_source_only_program_projection(
                repo,
                set,
                registry,
                product_filters,
                selected,
                graph_authority_sha256,
                receipts,
            )?;
            if refreshed != candidate {
                return Err(
                    "source-only program authority changed at the publication boundary".to_string(),
                );
            }
            authority.replace_projection_authority(&refreshed)
        } else {
            // Trusted path: the candidate was derived from the same receipts and
            // graph authority this publication commits, so skip the second
            // whole-graph re-derivation (`--verify-cache` restores it).
            authority.replace_projection_authority(&candidate)
        }
    })
}

fn exact_canonical_regular_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be absolute: {}", path.display()));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{label} must be a regular nonsymlink file: {}",
            path.display()
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("canonicalize {label} {}: {error}", path.display()))?;
    if canonical != path {
        return Err(format!(
            "{label} must use exact canonical spelling {}; got {}",
            canonical.display(),
            path.display()
        ));
    }
    Ok(canonical)
}

fn validate_absent_result_target(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "local-build child result path must be absolute: {}",
            path.display()
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        format!(
            "local-build child result path has no parent: {}",
            path.display()
        )
    })?;
    exact_canonical_directory(parent, "local-build child result parent")?;
    path.file_name().ok_or_else(|| {
        format!(
            "local-build child result path has no filename: {}",
            path.display()
        )
    })?;
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!(
            "local-build child result path must be absent: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "inspect local-build child result path {}: {error}",
            path.display()
        )),
    }
}

fn write_node_result_no_replace(path: &Path, result: &NodeExecutionResultV1) -> Result<(), String> {
    validate_absent_result_target(path)?;
    let bytes = canonical_machine_json(result)?;
    if bytes.len() > 64 * 1024 {
        return Err(format!(
            "local-build child result is {} bytes, exceeding the 64 KiB protocol limit",
            bytes.len()
        ));
    }
    let parent = path.parent().expect("validated child result parent");
    let mut stage = None;
    for _ in 0..10_000 {
        let sequence = LOCAL_BUILD_RESULT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(
            ".local-build-result-{}-{sequence}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&candidate) {
            Ok(file) => {
                stage = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "create private local-build child result stage {}: {error}",
                    candidate.display()
                ));
            }
        }
    }
    let (stage_path, mut stage_file) =
        stage.ok_or_else(|| "could not allocate a child result stage".to_string())?;
    let publication = (|| {
        stage_file.write_all(&bytes).map_err(|error| {
            format!("write child result stage {}: {error}", stage_path.display())
        })?;
        stage_file.sync_all().map_err(|error| {
            format!("sync child result stage {}: {error}", stage_path.display())
        })?;
        drop(stage_file);
        let staged =
            read_stable_regular_file(&stage_path, 64 * 1024, "staged local-build child result")?;
        if staged != bytes {
            return Err(
                "staged local-build child result bytes changed before publication".to_string(),
            );
        }
        rename_no_replace(&stage_path, path).map_err(|error| {
            format!(
                "publish local-build child result {} without replacement: {error}",
                path.display()
            )
        })?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| {
                format!(
                    "sync local-build child result parent {}: {error}",
                    parent.display()
                )
            })?;
        let published =
            read_stable_regular_file(path, 64 * 1024, "published local-build child result")?;
        if published != bytes {
            return Err("published local-build child result bytes changed".to_string());
        }
        Ok(())
    })();
    if publication.is_err() {
        let _ = fs::remove_file(&stage_path);
    }
    publication
}

#[allow(clippy::too_many_arguments)]
fn run_child_process(
    repo: &Path,
    set: &Path,
    authority_sha256: &str,
    source_cache_root: &Path,
    compiled_cache_root: &Path,
    output_root: &Path,
    node: &PlanNodeV1,
    result_json: &Path,
    rebuild: bool,
    verify_cache: bool,
    receipt_required: bool,
) -> Result<ValidatedChildResultV1, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("resolve current xtask executable: {error}"))?;
    let mut command = Command::new(executable);
    command
        .arg("local-build")
        .arg("run-node")
        .arg("--repo-root")
        .arg(repo)
        .arg("--set")
        .arg(set)
        .arg("--graph-authority-sha256")
        .arg(authority_sha256)
        .arg("--source-cache-root")
        .arg(source_cache_root)
        .arg("--compiled-cache-root")
        .arg(compiled_cache_root)
        .arg("--output-root")
        .arg(output_root)
        .arg("--result-json")
        .arg(result_json)
        .env("WASM_POSIX_DEPS_REGISTRY", repo.join("packages/registry"))
        .env("WASM_POSIX_BINARY_RESOLVER_REPO_ROOT", repo);
    match node {
        PlanNodeV1::Package { name, target_arch } => {
            command
                .args(["--node-kind", "package", "--package"])
                .arg(name)
                .arg("--target-arch")
                .arg(target_arch);
        }
        PlanNodeV1::Product { id } => {
            command
                .args(["--node-kind", "product", "--product"])
                .arg(id);
        }
    }
    if rebuild {
        command.arg("--rebuild");
    }
    if verify_cache {
        command.arg("--verify-cache");
    }
    let output = command
        .output()
        .map_err(|error| format!("spawn local-build child {}: {error}", node_label(node)))?;
    forward_child_output(node, &output.stdout);
    forward_child_output(node, &output.stderr);
    let bytes = read_stable_regular_file(result_json, 64 * 1024, "local-build child result")?;
    let exit_code = output.status.code();
    validate_child_result(node, receipt_required, exit_code, &bytes)
}

fn forward_child_output(node: &PlanNodeV1, bytes: &[u8]) {
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        eprint!("[{}] {}", node_label(node), String::from_utf8_lossy(line));
        if !line.ends_with(b"\n") {
            eprintln!();
        }
    }
}

fn render_scheduler_event(event: SchedulerEventV1, color: bool, aggregate_failed: &mut bool) {
    let continuing = *aggregate_failed;
    match event {
        SchedulerEventV1::Ready { node } => eprintln!(
            "{}{} {}",
            continuing_prefix(continuing, color),
            render_lifecycle_token(LifecycleTokenV1::Ready, color),
            node_label(&node),
        ),
        SchedulerEventV1::Running { node } => eprintln!(
            "{}{} {}",
            continuing_prefix(continuing, color),
            render_lifecycle_token(LifecycleTokenV1::Running, color),
            node_label(&node),
        ),
        SchedulerEventV1::Terminal { result } => match result {
            NodeRunResultV1::Succeeded { node, disposition } => {
                let token = match disposition {
                    SuccessDispositionV1::Cached => LifecycleTokenV1::Cached,
                    SuccessDispositionV1::Published => LifecycleTokenV1::Succeeded,
                    SuccessDispositionV1::RebuiltEquivalent => LifecycleTokenV1::Reused,
                };
                eprintln!(
                    "{}{} {}",
                    continuing_prefix(continuing, color),
                    render_lifecycle_token(token, color),
                    node_label(&node),
                );
            }
            NodeRunResultV1::Failed { node, .. } => {
                if !*aggregate_failed {
                    eprintln!("{}", render_failure_banner(color));
                    *aggregate_failed = true;
                }
                eprintln!(
                    "{}{} {}",
                    continuing_prefix(true, color),
                    render_lifecycle_token(LifecycleTokenV1::Failed, color),
                    node_label(&node),
                );
            }
            NodeRunResultV1::Blocked { node, .. } => eprintln!(
                "{}{} {}",
                continuing_prefix(*aggregate_failed, color),
                render_lifecycle_token(LifecycleTokenV1::Blocked, color),
                node_label(&node),
            ),
        },
    }
}

fn render_failure_banner(color: bool) -> String {
    const BANNER: &str = "LOCAL BUILD FAILED — continuing independent work";
    if color {
        format!("\u{1b}[31m{BANNER}\u{1b}[0m")
    } else {
        BANNER.to_string()
    }
}

fn render_projection_failure_banner(color: bool) -> String {
    const BANNER: &str =
        "LOCAL BUILD FAILED — source-only program authority was not published";
    if color {
        format!("\u{1b}[31m{BANNER}\u{1b}[0m")
    } else {
        BANNER.to_string()
    }
}

fn continuing_prefix(enabled: bool, color: bool) -> String {
    if enabled {
        format!(
            "{} · {} | ",
            render_lifecycle_token(LifecycleTokenV1::Failed, color),
            render_lifecycle_token(LifecycleTokenV1::Continuing, color),
        )
    } else {
        String::new()
    }
}

fn node_label(node: &PlanNodeV1) -> String {
    match node {
        PlanNodeV1::Package { name, target_arch } => format!("{name}/{target_arch}"),
        PlanNodeV1::Product { id } => format!("product/{id}"),
    }
}

fn create_run_directory(output_root: &Path) -> Result<PathBuf, String> {
    let parent = output_root.join(".kandelo");
    fs::create_dir_all(&parent).map_err(|error| {
        format!(
            "create local-build control directory {}: {error}",
            parent.display()
        )
    })?;
    exact_canonical_directory(&parent, "local-build control directory")?;
    for _ in 0..10_000 {
        let sequence = LOCAL_BUILD_RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".local-build-run-{}-{sequence}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "create private local-build run directory {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Err("could not allocate a private local-build run directory".to_string())
}

fn validate_run_roots(
    repo: &Path,
    set: &Path,
    source_cache_root: &Path,
    output_root: &Path,
) -> Result<(), String> {
    if paths_intersect(source_cache_root, output_root) {
        return Err("source cache and output roots must be disjoint".to_string());
    }
    for (label, root) in [("source cache", source_cache_root), ("output", output_root)] {
        if root == repo || repo.starts_with(root) {
            return Err(format!(
                "{label} root must not equal or contain the repository"
            ));
        }
        for authority_root in [
            repo.join("packages/registry"),
            repo.join("images/vfs/products"),
        ] {
            if paths_intersect(root, &authority_root) {
                return Err(format!(
                    "{label} root intersects graph authority {}",
                    authority_root.display()
                ));
            }
        }
        if set.starts_with(root) {
            return Err(format!("{label} root must not contain the supported set"));
        }
    }
    Ok(())
}

fn paths_intersect(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn canonicalize_with_missing_tail(path: &Path) -> Result<PathBuf, String> {
    let mut cursor = path;
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(cursor) {
            Ok(mut canonical) => {
                for component in missing.iter().rev() {
                    canonical.push(component);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(cursor.file_name().ok_or_else(|| {
                    format!(
                        "path has no existing canonical ancestor: {}",
                        path.display()
                    )
                })?);
                cursor = cursor.parent().ok_or_else(|| {
                    format!(
                        "path has no existing canonical ancestor: {}",
                        path.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!("canonicalize path {}: {error}", path.display()));
            }
        }
    }
}

fn exact_canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{label} must be a real nonsymlink directory: {}",
            path.display()
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("canonicalize {label} {}: {error}", path.display()))?;
    if canonical != path {
        return Err(format!(
            "{label} must use exact canonical spelling {}; got {}",
            canonical.display(),
            path.display()
        ));
    }
    Ok(canonical)
}

fn parse_supported_set(path: &Path) -> Result<LocalSupportedSetV1, String> {
    let bytes = read_stable_regular_file(path, MAX_SET_BYTES, "supported set")?;
    parse_supported_set_bytes(path, &bytes)
}

fn parse_supported_set_bytes(path: &Path, bytes: &[u8]) -> Result<LocalSupportedSetV1, String> {
    if bytes.is_empty() || bytes.len() > MAX_SET_BYTES {
        return Err(format!(
            "supported set {} must contain 1 through {MAX_SET_BYTES} bytes",
            path.display()
        ));
    }
    let source = std::str::from_utf8(bytes)
        .map_err(|error| format!("supported set {} is not UTF-8: {error}", path.display()))?;
    let set: LocalSupportedSetV1 = toml::from_str(&source)
        .map_err(|error| format!("supported set {} is invalid: {error}", path.display()))?;
    if set.schema != LOCAL_SUPPORTED_SCHEMA {
        return Err(format!(
            "supported set must use schema 1, got {}",
            set.schema
        ));
    }
    if set.policy != LOCAL_SUPPORTED_POLICY {
        return Err(format!(
            "supported set policy must be {LOCAL_SUPPORTED_POLICY:?}, got {:?}",
            set.policy
        ));
    }
    validate_authority_names(&set)?;
    Ok(set)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GraphFileSnapshot {
    repo_relative_path: String,
    bytes: Vec<u8>,
    raw_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GraphInputSnapshot {
    supported_set: GraphFileSnapshot,
    registry_package_toml: BTreeMap<String, GraphFileSnapshot>,
    product_toml: BTreeMap<String, GraphFileSnapshot>,
    directory_identities: BTreeMap<String, StableDirectoryIdentity>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StableDirectoryIdentity {
    device: u64,
    inode: u64,
}

fn snapshot_graph_inputs(repo: &Path, set_path: &Path) -> Result<GraphInputSnapshot, String> {
    let repo = canonical_real_directory(repo, "local-build repository root")?;
    let registry_root = repo.join("packages/registry");
    let product_root = repo.join("images/vfs/products");
    require_real_directory_beneath(&repo, &registry_root, "fixed package registry")?;
    require_real_directory_beneath(&repo, &product_root, "fixed product catalog")?;
    require_regular_path_beneath(&repo, set_path, "supported set")?;

    let supported_set = snapshot_graph_file(&repo, set_path, MAX_SET_BYTES, "supported set")?;
    let mut directory_identities = BTreeMap::new();
    directory_identities.insert(
        repo_relative_path(&repo, &registry_root)?,
        stable_directory_identity(&registry_root, "fixed package registry")?,
    );
    directory_identities.insert(
        repo_relative_path(&repo, &product_root)?,
        stable_directory_identity(&product_root, "fixed product catalog")?,
    );

    let mut registry_package_toml = BTreeMap::new();
    for entry in sorted_directory_entries(&registry_root, "fixed package registry")? {
        let name = normalized_entry_name(&entry, "fixed package registry")?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "cannot inspect fixed registry entry {}: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "fixed registry entry must not be a symlink: {}",
                path.display()
            ));
        }
        if !metadata.is_dir() {
            continue;
        }
        directory_identities.insert(
            repo_relative_path(&repo, &path)?,
            stable_directory_identity(&path, "registry package directory")?,
        );
        let manifest_path = path.join("package.toml");
        match fs::symlink_metadata(&manifest_path) {
            Ok(_) => {
                let snapshot = snapshot_graph_file(
                    &repo,
                    &manifest_path,
                    MAX_GRAPH_MANIFEST_BYTES,
                    "registry package.toml",
                )?;
                registry_package_toml.insert(name, snapshot);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "cannot inspect registry manifest {}: {error}",
                    manifest_path.display()
                ));
            }
        }
    }

    let mut product_toml = BTreeMap::new();
    for entry in sorted_directory_entries(&product_root, "fixed product catalog")? {
        let name = normalized_entry_name(&entry, "fixed product catalog")?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "cannot inspect product catalog entry {}: {error}",
                path.display()
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "product catalog entry must be a regular nonsymlink file or real directory: {}",
                path.display()
            ));
        }
        if metadata.is_dir() {
            directory_identities.insert(
                repo_relative_path(&repo, &path)?,
                stable_directory_identity(&path, "product catalog directory")?,
            );
            continue;
        }
        if metadata.is_file() && name.ends_with(".toml") && !name.starts_with('.') {
            let snapshot =
                snapshot_graph_file(&repo, &path, MAX_GRAPH_MANIFEST_BYTES, "product manifest")?;
            product_toml.insert(snapshot.repo_relative_path.clone(), snapshot);
        }
    }
    if product_toml.is_empty() {
        return Err(format!(
            "product directory {} is empty",
            product_root.display()
        ));
    }

    Ok(GraphInputSnapshot {
        supported_set,
        registry_package_toml,
        product_toml,
        directory_identities,
    })
}

fn snapshot_graph_file(
    repo: &Path,
    path: &Path,
    limit: usize,
    label: &str,
) -> Result<GraphFileSnapshot, String> {
    let bytes = read_stable_regular_file(path, limit, label)?;
    Ok(GraphFileSnapshot {
        repo_relative_path: repo_relative_path(repo, path)?,
        raw_sha256: sha256_bytes(&bytes),
        bytes,
    })
}

fn sorted_directory_entries(path: &Path, label: &str) -> Result<Vec<fs::DirEntry>, String> {
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("cannot read {label} {}: {error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("cannot read entry in {label} {}: {error}", path.display()))?;
    entries.sort_by_key(fs::DirEntry::file_name);
    Ok(entries)
}

fn normalized_entry_name(entry: &fs::DirEntry, label: &str) -> Result<String, String> {
    let name = entry
        .file_name()
        .into_string()
        .map_err(|_| format!("{label} entry name is not valid UTF-8"))?;
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(format!("{label} entry name is not normalized: {name:?}"));
    }
    Ok(name)
}

fn canonical_real_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} must be absolute: {}", path.display()));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("cannot inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "{label} must be a real nonsymlink directory: {}",
            path.display()
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("cannot canonicalize {label} {}: {error}", path.display()))?;
    Ok(canonical)
}

fn require_real_directory_beneath(repo: &Path, path: &Path, label: &str) -> Result<(), String> {
    require_path_components_beneath(repo, path, label, true)
}

fn require_regular_path_beneath(repo: &Path, path: &Path, label: &str) -> Result<(), String> {
    require_path_components_beneath(repo, path, label, false)
}

fn require_path_components_beneath(
    repo: &Path,
    path: &Path,
    label: &str,
    leaf_is_directory: bool,
) -> Result<(), String> {
    let relative = path
        .strip_prefix(repo)
        .map_err(|_| format!("{label} escapes repository root: {}", path.display()))?;
    let mut cursor = repo.to_path_buf();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(component) = component else {
            return Err(format!(
                "{label} path is not normalized: {}",
                path.display()
            ));
        };
        cursor.push(component);
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|error| format!("cannot inspect {label} {}: {error}", cursor.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "{label} must not traverse a symlink: {}",
                cursor.display()
            ));
        }
        let is_leaf = index + 1 == relative.components().count();
        if !is_leaf && !metadata.is_dir() {
            return Err(format!(
                "{label} parent must be a real directory: {}",
                cursor.display()
            ));
        }
        if is_leaf
            && ((leaf_is_directory && !metadata.is_dir())
                || (!leaf_is_directory && !metadata.is_file()))
        {
            return Err(format!(
                "{label} must be a regular nonsymlink {}: {}",
                if leaf_is_directory {
                    "directory"
                } else {
                    "file"
                },
                cursor.display(),
            ));
        }
    }
    Ok(())
}

fn repo_relative_path(repo: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(repo)
        .map_err(|_| format!("path escapes repository root: {}", path.display()))?;
    let mut parts = Vec::new();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(format!(
                "repository path is not normalized: {}",
                path.display()
            ));
        };
        parts.push(
            component
                .to_str()
                .ok_or_else(|| format!("repository path is not UTF-8: {}", path.display()))?,
        );
    }
    if parts.is_empty() {
        return Err("repository-relative graph input path must not be empty".to_string());
    }
    Ok(parts.join("/"))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StableFileIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    links: u64,
    length: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[cfg(unix)]
fn stable_file_identity(metadata: &fs::Metadata) -> StableFileIdentity {
    use std::os::unix::fs::MetadataExt;
    StableFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
        links: metadata.nlink(),
        length: metadata.len(),
        modified_seconds: metadata.mtime(),
        modified_nanoseconds: metadata.mtime_nsec(),
        changed_seconds: metadata.ctime(),
        changed_nanoseconds: metadata.ctime_nsec(),
    }
}

fn stable_directory_identity(path: &Path, label: &str) -> Result<StableDirectoryIdentity, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, label);
        Err("stable graph authority requires Unix filesystem identity semantics".to_string())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("cannot inspect {label} {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(format!(
                "{label} must be a real nonsymlink directory: {}",
                path.display()
            ));
        }
        Ok(StableDirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
}

fn read_stable_regular_file(path: &Path, limit: usize, label: &str) -> Result<Vec<u8>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, limit, label);
        Err("stable graph authority reads require Unix no-follow semantics".to_string())
    }
    #[cfg(unix)]
    {
        let pathname_metadata = fs::symlink_metadata(path)
            .map_err(|error| format!("cannot inspect {label} {}: {error}", path.display()))?;
        if pathname_metadata.file_type().is_symlink() || !pathname_metadata.is_file() {
            return Err(format!(
                "{label} must be a regular nonsymlink file: {}",
                path.display()
            ));
        }
        let open = || {
            rustix::fs::open(
                path,
                rustix::fs::OFlags::RDONLY
                    | rustix::fs::OFlags::CLOEXEC
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::NONBLOCK,
                rustix::fs::Mode::empty(),
            )
            .map(fs::File::from)
            .map_err(|error| {
                format!(
                    "cannot open {label} {} without following: {error}",
                    path.display()
                )
            })
        };
        let mut file = open()?;
        let initial_metadata = file.metadata().map_err(|error| {
            format!("cannot inspect opened {label} {}: {error}", path.display())
        })?;
        if !initial_metadata.is_file() {
            return Err(format!(
                "{label} must be a regular nonsymlink file: {}",
                path.display()
            ));
        }
        if initial_metadata.len() == 0 || initial_metadata.len() > limit as u64 {
            return Err(format!(
                "{label} {} must contain 1 through {limit} bytes",
                path.display()
            ));
        }
        let initial = stable_file_identity(&initial_metadata);
        let mut bytes = Vec::with_capacity(initial.length as usize);
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("cannot read {label} {}: {error}", path.display()))?;
        let after = stable_file_identity(&file.metadata().map_err(|error| {
            format!(
                "cannot reinspect opened {label} {}: {error}",
                path.display()
            )
        })?);
        let reopened = open()?;
        let reopened_metadata = reopened.metadata().map_err(|error| {
            format!(
                "cannot inspect reopened {label} {}: {error}",
                path.display()
            )
        })?;
        if !reopened_metadata.is_file()
            || bytes.len() as u64 != initial.length
            || after != initial
            || stable_file_identity(&reopened_metadata) != initial
        {
            return Err(format!(
                "{label} changed while snapshotted: {}",
                path.display()
            ));
        }
        Ok(bytes)
    }
}

fn validate_authority_names(set: &LocalSupportedSetV1) -> Result<(), String> {
    let mut package_dispositions = BTreeMap::<&str, &str>::new();
    for package in &set.packages {
        validate_name(&package.name, "package name")?;
        insert_unique(&mut package_dispositions, &package.name, "selected")?;
    }
    for exclusion in &set.exclusions {
        validate_exclusion(exclusion, "excluded root")?;
        insert_unique(&mut package_dispositions, &exclusion.name, "excluded")?;
    }
    for name in &set.dependency_only {
        validate_name(name, "dependency-only package name")?;
        insert_unique(&mut package_dispositions, name, "dependency-only")?;
    }
    for non_root in &set.registry_non_roots {
        validate_exclusion(non_root, "registry non-root")?;
        insert_unique(&mut package_dispositions, &non_root.name, "non-root")?;
    }

    let mut product_ids = BTreeSet::new();
    for product in &set.products {
        validate_name(&product.id, "product id")?;
        validate_name(&product.package, "product package name")?;
        if !product_ids.insert(product.id.as_str()) {
            return Err(format!("duplicate selected product {:?}", product.id));
        }
        validate_relative_path(&product.manifest, "product manifest")?;
        let mut package_dependencies = BTreeSet::new();
        for package in &product.package_dependencies {
            validate_name(package, "product package dependency name")?;
            if !package_dependencies.insert(package.as_str()) {
                return Err(format!(
                    "product {:?} repeats package dependency {:?}",
                    product.id, package
                ));
            }
        }
        let mut root_mirror_packages = BTreeSet::new();
        for package in &product.root_mirror_packages {
            validate_name(package, "product root-mirror package name")?;
            if !root_mirror_packages.insert(package.as_str()) {
                return Err(format!(
                    "product {:?} repeats root-mirror package {:?}",
                    product.id, package
                ));
            }
            if package_dependencies.contains(package.as_str()) {
                return Err(format!(
                    "product {:?} claims package {:?} as both an ordinary dependency and a root mirror",
                    product.id, package
                ));
            }
        }
    }
    for dormant in &set.dormant_products {
        validate_exclusion(dormant, "dormant product")?;
        if !product_ids.insert(dormant.name.as_str()) {
            return Err(format!(
                "product {:?} is both selected and dormant",
                dormant.name
            ));
        }
    }
    Ok(())
}

fn validate_exclusion(exclusion: &ExcludedRootV1, label: &str) -> Result<(), String> {
    validate_name(&exclusion.name, label)?;
    if exclusion.reason.trim().is_empty() || exclusion.reason != exclusion.reason.trim() {
        return Err(format!(
            "{label} {:?} must have a normalized reason",
            exclusion.name
        ));
    }
    Ok(())
}

fn insert_unique<'a>(
    dispositions: &mut BTreeMap<&'a str, &'a str>,
    name: &'a str,
    disposition: &'a str,
) -> Result<(), String> {
    if let Some(previous) = dispositions.insert(name, disposition) {
        return Err(format!(
            "package {name:?} has duplicate dispositions {previous:?} and {disposition:?}"
        ));
    }
    Ok(())
}

fn validate_name(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
        });
    if !valid {
        return Err(format!("{label} is not normalized: {value:?}"));
    }
    Ok(())
}

fn validate_relative_path(value: &str, label: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "{label} must be a normalized repository-relative path: {value:?}"
        ));
    }
    Ok(())
}

fn resolve_repo_file(repo: &Path, path: &Path, label: &str) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.join(path)
    };
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("cannot inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "{label} {} must be a regular nonsymlink file",
            path.display()
        ));
    }
    Ok(path)
}

fn load_and_plan(
    repo: &Path,
    set_path: &Path,
    _registry: &Registry,
) -> Result<PlannedGraphV1, String> {
    let repo = canonical_real_directory(repo, "local-build repository root")?;
    let set_metadata = fs::symlink_metadata(set_path).map_err(|error| {
        format!(
            "cannot inspect supported set {}: {error}",
            set_path.display()
        )
    })?;
    if set_metadata.file_type().is_symlink() || !set_metadata.is_file() {
        return Err(format!(
            "supported set {} must be a regular nonsymlink file",
            set_path.display()
        ));
    }
    let set_path = fs::canonicalize(set_path).map_err(|error| {
        format!(
            "cannot canonicalize supported set {}: {error}",
            set_path.display()
        )
    })?;
    let input_snapshot = snapshot_graph_inputs(&repo, &set_path)?;
    let set = parse_supported_set_bytes(&set_path, &input_snapshot.supported_set.bytes)?;
    let manifests = parse_registry_snapshot(&repo, &input_snapshot.registry_package_toml)?;
    validate_registry_partition(&set, &manifests, &repo)?;

    let catalog = parse_product_snapshot(&repo, &input_snapshot.product_toml)?;
    let catalog_by_id = catalog
        .iter()
        .map(|entry| (entry.manifest.id.as_str(), entry))
        .collect::<BTreeMap<_, _>>();
    validate_products(&set, &catalog_by_id, &manifests)?;

    let selected = set
        .packages
        .iter()
        .map(|package| package.name.as_str())
        .collect::<BTreeSet<_>>();
    let excluded = set
        .exclusions
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<BTreeSet<_>>();
    let dependency_only = set
        .dependency_only
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();

    let mut dependencies = BTreeMap::<PlanNodeV1, BTreeSet<PlanNodeV1>>::new();
    let mut public_dependencies = BTreeMap::<PlanNodeV1, BTreeSet<PlanNodeV1>>::new();
    for package in &set.packages {
        let manifest = &manifests[&package.name];
        for arch in &manifest.target_arches {
            let graph = resolved_dependency_graph_from_manifests(manifest, &manifests, *arch)?;
            add_resolved_package_graph(
                &package.name,
                &graph,
                &selected,
                &excluded,
                &dependency_only,
                &mut dependencies,
                &mut public_dependencies,
            )?;
        }
    }

    for product in &set.products {
        let entry = catalog_by_id[product.id.as_str()];
        let product_node = PlanNodeV1::product(&product.id);
        dependencies.entry(product_node.clone()).or_default();
        public_dependencies.entry(product_node.clone()).or_default();
        let target_arch = product_target_arch(entry.manifest.architecture);
        let mapped_manifest = &manifests[&product.package];
        if !mapped_manifest.target_arches.contains(&target_arch) {
            return Err(format!(
                "product {:?} maps to {} without architecture {}",
                product.id,
                product.package,
                target_arch.as_str()
            ));
        }
        let mapped_package = PlanNodeV1::package(&product.package, target_arch.as_str());
        add_edge(
            &mut dependencies,
            mapped_package.clone(),
            product_node.clone(),
        );
        add_edge(
            &mut public_dependencies,
            mapped_package,
            product_node.clone(),
        );
        for package_claim in &entry.manifest.software.package {
            let package_manifest = manifests.get(&package_claim.name).ok_or_else(|| {
                format!(
                    "product {:?} claims unknown package {:?}",
                    product.id, package_claim.name
                )
            })?;
            if excluded.contains(package_claim.name.as_str()) {
                return Err(format!(
                    "product {:?} claims excluded package {:?}",
                    product.id, package_claim.name
                ));
            }
            if dependency_only.contains(package_claim.name.as_str()) {
                return Err(format!(
                    "product {:?} claims dependency-only package {:?}",
                    product.id, package_claim.name
                ));
            }
            if !selected.contains(package_claim.name.as_str())
                || !is_buildable(package_manifest.kind)
            {
                return Err(format!(
                    "product {:?} claims package {:?} that is not a selected buildable root",
                    product.id, package_claim.name
                ));
            }
            let package_arch = canonical_package_target_arch(package_manifest, target_arch)
                .ok_or_else(|| {
                    format!(
                        "product {:?} claims package {:?} without architecture {} or wasm32",
                        product.id,
                        package_claim.name,
                        target_arch.as_str()
                    )
                })?;
            let package_node = PlanNodeV1::package(&package_claim.name, package_arch.as_str());
            add_edge(
                &mut dependencies,
                package_node.clone(),
                product_node.clone(),
            );
            add_edge(&mut public_dependencies, package_node, product_node.clone());
        }
        for package_name in &product.package_dependencies {
            let package_manifest = manifests.get(package_name).ok_or_else(|| {
                format!(
                    "product {:?} claims unknown package dependency {:?}",
                    product.id, package_name
                )
            })?;
            if !selected.contains(package_name.as_str()) || !is_buildable(package_manifest.kind) {
                return Err(format!(
                    "product {:?} claims package dependency {:?} that is not a selected buildable root",
                    product.id, package_name
                ));
            }
            if package_manifest.uses_root_binary_mirror() {
                return Err(format!(
                    "product {:?} claims root-mirror package {:?} as an ordinary dependency",
                    product.id, package_name
                ));
            }
            if package_name == &product.package
                || entry
                    .manifest
                    .software
                    .package
                    .iter()
                    .any(|claim| claim.name == package_name.as_str())
            {
                return Err(format!(
                    "product {:?} repeats package dependency {:?} in its mapped or production manifest packages",
                    product.id, package_name
                ));
            }
            let package_arch = canonical_package_target_arch(package_manifest, target_arch)
                .ok_or_else(|| {
                    format!(
                        "product {:?} claims package dependency {:?} without architecture {} or wasm32",
                        product.id,
                        package_name,
                        target_arch.as_str()
                    )
                })?;
            let package_node = PlanNodeV1::package(package_name, package_arch.as_str());
            add_edge(
                &mut dependencies,
                package_node.clone(),
                product_node.clone(),
            );
            add_edge(&mut public_dependencies, package_node, product_node.clone());
        }
        for package_name in &product.root_mirror_packages {
            let package_manifest = manifests.get(package_name).ok_or_else(|| {
                format!(
                    "product {:?} claims unknown root-mirror package {:?}",
                    product.id, package_name
                )
            })?;
            if !selected.contains(package_name.as_str()) || !is_buildable(package_manifest.kind) {
                return Err(format!(
                    "product {:?} claims root-mirror package {:?} that is not a selected buildable root",
                    product.id, package_name
                ));
            }
            if !package_manifest.uses_root_binary_mirror() {
                return Err(format!(
                    "product {:?} claims package {:?} as a root mirror, but its manifest does not publish a root-mirror artifact",
                    product.id, package_name
                ));
            }
            let package_arch = canonical_package_target_arch(package_manifest, target_arch)
                .ok_or_else(|| {
                    format!(
                        "product {:?} claims root-mirror package {:?} without architecture {} or wasm32",
                        product.id,
                        package_name,
                        target_arch.as_str()
                    )
                })?;
            let package_node = PlanNodeV1::package(package_name, package_arch.as_str());
            add_edge(
                &mut dependencies,
                package_node.clone(),
                product_node.clone(),
            );
            add_edge(&mut public_dependencies, package_node, product_node.clone());
        }
        for dependency in &entry.manifest.composition.product {
            if !set
                .products
                .iter()
                .any(|candidate| candidate.id == dependency.id)
            {
                return Err(format!(
                    "selected product {:?} composes unsupported product {:?}",
                    product.id, dependency.id
                ));
            }
            let dependency_product = PlanNodeV1::product(&dependency.id);
            add_edge(
                &mut dependencies,
                dependency_product.clone(),
                product_node.clone(),
            );
            add_edge(
                &mut public_dependencies,
                dependency_product,
                product_node.clone(),
            );
        }
    }

    let mut packages = set
        .packages
        .iter()
        .map(|package| {
            let mut architectures = manifests[&package.name]
                .target_arches
                .iter()
                .map(|arch| arch.as_str().to_string())
                .collect::<Vec<_>>();
            architectures.sort();
            PlannedPackageV1 {
                name: package.name.clone(),
                class: package.class.as_str().to_string(),
                reason: format!("supported {} root", package.class.as_str()),
                architectures,
            }
        })
        .collect::<Vec<_>>();
    packages.sort_by(|left, right| left.name.cmp(&right.name));

    let mut products = set
        .products
        .iter()
        .map(|product| {
            let manifest = &catalog_by_id[product.id.as_str()].manifest;
            PlannedProductV1 {
                id: product.id.clone(),
                package: product.package.clone(),
                manifest: product.manifest.clone(),
                architecture: product_target_arch(manifest.architecture)
                    .as_str()
                    .to_string(),
                reason: format!(
                    "supported VFS product mapped to package {}",
                    product.package
                ),
            }
        })
        .collect::<Vec<_>>();
    products.sort_by(|left, right| left.id.cmp(&right.id));

    let mut exclusions = Vec::new();
    extend_exclusions(&mut exclusions, &set.exclusions, "excluded-root");
    exclusions.extend(set.dependency_only.iter().map(|name| PlanExclusionV1 {
        name: name.clone(),
        disposition: "dependency-only".to_string(),
        reason: "immutable source input; not a schedulable build root".to_string(),
    }));
    extend_exclusions(
        &mut exclusions,
        &set.registry_non_roots,
        "registry-non-root",
    );
    extend_exclusions(&mut exclusions, &set.dormant_products, "dormant-product");
    exclusions.sort_by(|left, right| {
        (&left.disposition, &left.name).cmp(&(&right.disposition, &right.name))
    });

    let mut product_bindings = set
        .products
        .iter()
        .map(|product| {
            let entry = catalog_by_id[product.id.as_str()];
            ProductBindingV1 {
                id: product.id.clone(),
                mapped_package: product.package.clone(),
                target_arch: product_target_arch(entry.manifest.architecture)
                    .as_str()
                    .to_string(),
                repo_relative_manifest_path: entry.path.clone(),
                manifest_sha256: entry.sha256.clone(),
            }
        })
        .collect::<Vec<_>>();
    product_bindings.sort();
    let product_execution = product_bindings
        .iter()
        .map(|binding| {
            let entry = catalog_by_id[binding.id.as_str()];
            (
                binding.id.clone(),
                ProductExecutionAuthorityV1 {
                    binding: binding.clone(),
                    manifest: entry.manifest.clone(),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut direct_edges = dependencies
        .iter()
        .flat_map(|(dependent, required)| {
            required.iter().map(|dependency| GraphDirectEdgeV1 {
                dependency: dependency.clone(),
                dependent: dependent.clone(),
            })
        })
        .collect::<Vec<_>>();
    direct_edges.sort();
    let mut registry_package_toml = input_snapshot
        .registry_package_toml
        .values()
        .map(|snapshot| RegistryPackageTomlAuthorityV1 {
            repo_relative_path: snapshot.repo_relative_path.clone(),
            raw_sha256: snapshot.raw_sha256.clone(),
        })
        .collect::<Vec<_>>();
    registry_package_toml.sort();
    let authority = GraphAuthorityV1 {
        schema: 1,
        policy: LOCAL_SUPPORTED_POLICY.to_string(),
        supported_set_sha256: input_snapshot.supported_set.raw_sha256.clone(),
        registry_package_toml,
        nodes: dependencies.keys().cloned().collect(),
        direct_edges,
        product_bindings,
    };
    let authority_bytes = graph_authority_bytes(&authority)?;
    let mut authority_hash = Sha256::new();
    authority_hash.update(GRAPH_AUTHORITY_DOMAIN);
    authority_hash.update(&authority_bytes);
    let authority_sha256 = format!("{:x}", authority_hash.finalize());

    let refreshed_snapshot = snapshot_graph_inputs(&repo, &set_path)?;
    if refreshed_snapshot != input_snapshot {
        return Err("local-build graph authority inputs changed while planning".to_string());
    }

    Ok(PlannedGraphV1 {
        plan: LocalBuildPlanV1 {
            schema: LOCAL_SUPPORTED_SCHEMA,
            policy: LOCAL_SUPPORTED_POLICY.to_string(),
            packages,
            products,
            levels: topological_levels(public_dependencies)?,
            exclusions,
        },
        dependencies,
        authority,
        authority_sha256,
        product_execution,
    })
}

fn parse_registry_snapshot(
    repo: &Path,
    snapshots: &BTreeMap<String, GraphFileSnapshot>,
) -> Result<BTreeMap<String, DepsManifest>, String> {
    let mut manifests = BTreeMap::new();
    for (directory_name, snapshot) in snapshots {
        let text = std::str::from_utf8(&snapshot.bytes).map_err(|error| {
            format!(
                "registry manifest {} is not UTF-8: {error}",
                snapshot.repo_relative_path
            )
        })?;
        let path = repo.join(&snapshot.repo_relative_path);
        let dir = path.parent().ok_or_else(|| {
            format!(
                "registry manifest has no package directory: {}",
                path.display()
            )
        })?;
        let manifest = DepsManifest::parse(text, dir.to_path_buf())
            .map_err(|error| format!("{}: {error}", path.display()))?;
        if manifest.name != *directory_name {
            return Err(format!(
                "{}: package name {:?} does not match registry directory {:?}",
                path.display(),
                manifest.name,
                directory_name,
            ));
        }
        manifests.insert(manifest.name.clone(), manifest);
    }
    Ok(manifests)
}

fn parse_product_snapshot(
    repo: &Path,
    snapshots: &BTreeMap<String, GraphFileSnapshot>,
) -> Result<Vec<VfsProductCatalogEntryV1>, String> {
    if snapshots.len() > 256 {
        return Err(format!(
            "product directory contains {} manifests; maximum is 256",
            snapshots.len()
        ));
    }
    let mut products = snapshots
        .values()
        .map(|snapshot| {
            let path = repo.join(&snapshot.repo_relative_path);
            let manifest = parse_product_manifest_bytes(repo, &path, &snapshot.bytes)?;
            Ok(VfsProductCatalogEntryV1 {
                path: snapshot.repo_relative_path.clone(),
                sha256: canonical_sha256(&manifest)?,
                manifest,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    validate_product_catalog_entries(&products)?;
    products.sort_by(|left, right| left.manifest.id.cmp(&right.manifest.id));
    Ok(products)
}

fn validate_registry_partition(
    set: &LocalSupportedSetV1,
    manifests: &BTreeMap<String, DepsManifest>,
    repo: &Path,
) -> Result<(), String> {
    let mut dispositions = BTreeSet::new();
    for name in set
        .packages
        .iter()
        .map(|entry| entry.name.as_str())
        .chain(set.exclusions.iter().map(|entry| entry.name.as_str()))
        .chain(set.dependency_only.iter().map(String::as_str))
        .chain(
            set.registry_non_roots
                .iter()
                .map(|entry| entry.name.as_str()),
        )
    {
        if !manifests.contains_key(name) {
            return Err(format!("authority references unknown package {name:?}"));
        }
        dispositions.insert(name);
    }
    for name in manifests.keys() {
        if !dispositions.contains(name.as_str()) {
            return Err(format!("unclassified registry root {name:?}"));
        }
    }
    for name in set
        .packages
        .iter()
        .map(|package| package.name.as_str())
        .chain(set.dependency_only.iter().map(String::as_str))
    {
        if !manifests[name].source.provider_was_explicit {
            return Err(format!(
                "local source authority package {name:?} must declare [source].provider explicitly"
            ));
        }
        if matches!(
            manifests[name].source.provider,
            SourceProvider::Repository | SourceProvider::DevShell
        ) {
            let build = BuildToml::load(&manifests[name].dir).map_err(|error| {
                format!(
                    "local source authority package {name:?} with provider {:?} requires valid build.toml: {error}",
                    manifests[name].source.provider.as_str()
                )
            })?;
            if build.inputs.is_empty() {
                return Err(format!(
                    "local source authority package {name:?} with provider {:?} requires non-empty build.toml.inputs",
                    manifests[name].source.provider.as_str()
                ));
            }
        }
    }
    for package in &set.packages {
        let manifest = &manifests[&package.name];
        if matches!(manifest.kind, ManifestKind::Source) {
            return Err(format!(
                "selected package {:?} is source-only",
                package.name
            ));
        }
        let script = manifest.build_script_path(repo);
        let metadata = fs::symlink_metadata(&script).map_err(|error| {
            format!(
                "selected package {:?} has no effective build hook {}: {error}",
                package.name,
                script.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(format!(
                "selected package {:?} effective build hook must be a regular nonsymlink file: {}",
                package.name,
                script.display()
            ));
        }
    }
    for name in &set.dependency_only {
        if !matches!(manifests[name].kind, ManifestKind::Source) {
            return Err(format!(
                "dependency-only package {name:?} must be kind source"
            ));
        }
    }
    Ok(())
}

fn validate_products<'a>(
    set: &LocalSupportedSetV1,
    catalog: &BTreeMap<&'a str, &'a crate::vfs_products::product_manifest::VfsProductCatalogEntryV1>,
    manifests: &BTreeMap<String, DepsManifest>,
) -> Result<(), String> {
    let selected_packages = set
        .packages
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<BTreeSet<_>>();
    for product in &set.products {
        if !selected_packages.contains(product.package.as_str()) {
            return Err(format!(
                "product {:?} maps to non-selected package {:?}",
                product.id, product.package
            ));
        }
        if !manifests.contains_key(&product.package) {
            return Err(format!("product {:?} maps to unknown package", product.id));
        }
        let entry = catalog
            .get(product.id.as_str())
            .ok_or_else(|| format!("unknown product {:?}", product.id))?;
        if entry.path != product.manifest {
            return Err(format!(
                "product {:?} manifest mismatch: authority has {:?}, catalog has {:?}",
                product.id, product.manifest, entry.path
            ));
        }
    }
    for dormant in &set.dormant_products {
        if !catalog.contains_key(dormant.name.as_str()) {
            return Err(format!("unknown dormant product {:?}", dormant.name));
        }
    }
    Ok(())
}

fn add_resolved_package_graph(
    root: &str,
    graph: &ResolvedDependencyGraph,
    selected: &BTreeSet<&str>,
    excluded: &BTreeSet<&str>,
    dependency_only: &BTreeSet<&str>,
    dependencies: &mut BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    public_dependencies: &mut BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
) -> Result<(), String> {
    for node in graph.nodes.keys() {
        if excluded.contains(node.package_name.as_str()) {
            return Err(format!(
                "selected closure for {root} reaches excluded package {}",
                node.package_name,
            ));
        }
    }
    for (node, kind) in &graph.nodes {
        match kind {
            ManifestKind::Source => {
                if !dependency_only.contains(node.package_name.as_str()) {
                    return Err(format!(
                        "selected closure for {root} reaches source package {} that is not declared as dependency-only",
                        node.package_name,
                    ));
                }
            }
            ManifestKind::Library | ManifestKind::Program => {
                if !selected.contains(node.package_name.as_str()) {
                    return Err(format!(
                        "selected closure for {root} reaches non-selected buildable package {}",
                        node.package_name,
                    ));
                }
            }
        }
    }
    for node in graph.nodes.keys() {
        dependencies.entry(plan_package_node(node)).or_default();
    }
    for (node, kind) in &graph.nodes {
        if is_buildable(*kind) {
            public_dependencies
                .entry(plan_package_node(node))
                .or_default();
        }
    }
    for (dependency, dependent) in &graph.direct_edges {
        let dependency_kind = graph.nodes.get(dependency).ok_or_else(|| {
            format!(
                "resolved dependency graph omits node {}/{}",
                dependency.package_name,
                dependency.target_arch.as_str(),
            )
        })?;
        let dependent_kind = graph.nodes.get(dependent).ok_or_else(|| {
            format!(
                "resolved dependency graph omits node {}/{}",
                dependent.package_name,
                dependent.target_arch.as_str(),
            )
        })?;
        add_edge(
            dependencies,
            plan_package_node(dependency),
            plan_package_node(dependent),
        );
        if is_buildable(*dependency_kind) && is_buildable(*dependent_kind) {
            add_edge(
                public_dependencies,
                plan_package_node(dependency),
                plan_package_node(dependent),
            );
        }
    }
    Ok(())
}

fn is_buildable(kind: ManifestKind) -> bool {
    matches!(kind, ManifestKind::Library | ManifestKind::Program)
}

fn plan_package_node(node: &ResolvedDependencyNode) -> PlanNodeV1 {
    PlanNodeV1::package(&node.package_name, node.target_arch.as_str())
}

fn add_edge(
    edges: &mut BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
    dependency: PlanNodeV1,
    dependent: PlanNodeV1,
) {
    edges.entry(dependency.clone()).or_default();
    edges.entry(dependent).or_default().insert(dependency);
}

fn topological_levels(
    mut dependencies: BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>,
) -> Result<Vec<Vec<PlanNodeV1>>, String> {
    let mut levels = Vec::new();
    while !dependencies.is_empty() {
        let level = dependencies
            .iter()
            .filter(|(_, required)| required.is_empty())
            .map(|(node, _)| node.clone())
            .collect::<Vec<_>>();
        if level.is_empty() {
            return Err("local build graph contains a cycle".to_string());
        }
        for node in &level {
            dependencies.remove(node);
        }
        for required in dependencies.values_mut() {
            for node in &level {
                required.remove(node);
            }
        }
        levels.push(level);
    }
    Ok(levels)
}

fn select_graph_dependencies(
    graph: &PlannedGraphV1,
    product_filters: &[String],
) -> Result<BTreeMap<PlanNodeV1, BTreeSet<PlanNodeV1>>, String> {
    let mut unique = BTreeSet::new();
    for product in product_filters {
        if !unique.insert(product.as_str()) {
            return Err(format!("repeated product filter {product:?}"));
        }
    }
    if unique.contains("all") && unique.len() != 1 {
        return Err("product filter 'all' may not be mixed with product IDs".to_string());
    }
    if product_filters.is_empty() || unique.contains("all") {
        return Ok(graph.dependencies.clone());
    }

    let active_products = graph
        .dependencies
        .keys()
        .filter_map(|node| match node {
            PlanNodeV1::Product { id } => Some(id.as_str()),
            PlanNodeV1::Package { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    let dormant_products = graph
        .plan
        .exclusions
        .iter()
        .filter(|entry| entry.disposition == "dormant-product")
        .map(|entry| entry.name.as_str())
        .collect::<BTreeSet<_>>();
    // Package nodes, keyed by (name, target_arch), so a bare `xtask bootstrap
    // <target>` positional (run.sh's former `build_<pkg>` targets: `kernel`,
    // `zlib`, `mariadb64`, ...) can select a single registry package the same
    // way a declared product id already can, without requiring every
    // package to also be declared as a VFS product.
    let package_names = graph
        .dependencies
        .keys()
        .filter_map(|node| match node {
            PlanNodeV1::Package { name, target_arch } => {
                Some((name.as_str(), target_arch.as_str()))
            }
            PlanNodeV1::Product { .. } => None,
        })
        .collect::<BTreeSet<_>>();

    let mut selected = BTreeSet::new();
    let mut pending = Vec::new();
    for filter in product_filters {
        if active_products.contains(filter.as_str()) {
            pending.push(PlanNodeV1::product(filter));
            continue;
        }
        if dormant_products.contains(filter.as_str()) {
            return Err(format!("product {filter:?} is dormant"));
        }
        if package_names.contains(&(filter.as_str(), "wasm32")) {
            pending.push(PlanNodeV1::package(filter, "wasm32"));
            continue;
        }
        // `./run.sh build mariadb64` names the wasm64 build of the `mariadb`
        // package; the package graph itself has no node literally named
        // "mariadb64". Strip the historical "64" suffix convention and look
        // for the wasm64 variant of the base package name.
        if let Some(base) = filter.strip_suffix("64") {
            if package_names.contains(&(base, "wasm64")) {
                pending.push(PlanNodeV1::package(base, "wasm64"));
                continue;
            }
        }
        if package_names.contains(&(filter.as_str(), "wasm64")) {
            pending.push(PlanNodeV1::package(filter, "wasm64"));
            continue;
        }
        return Err(format!("unknown product or package {filter:?}"));
    }
    while let Some(node) = pending.pop() {
        if !selected.insert(node.clone()) {
            continue;
        }
        let dependencies = graph
            .dependencies
            .get(&node)
            .ok_or_else(|| format!("internal local-build graph omitted selected node {node:?}"))?;
        pending.extend(dependencies.iter().cloned());
    }

    graph
        .dependencies
        .iter()
        .filter(|(node, _)| selected.contains(*node))
        .map(|(node, dependencies)| {
            if dependencies
                .iter()
                .all(|dependency| selected.contains(dependency))
            {
                Ok((node.clone(), dependencies.clone()))
            } else {
                Err(format!(
                    "internal local-build selection omitted a prerequisite of {node:?}"
                ))
            }
        })
        .collect()
}

fn product_target_arch(architecture: VfsArchitectureV1) -> TargetArch {
    match architecture {
        VfsArchitectureV1::Wasm32 => TargetArch::Wasm32,
        VfsArchitectureV1::Wasm64 => TargetArch::Wasm64,
    }
}

fn extend_exclusions(
    target: &mut Vec<PlanExclusionV1>,
    source: &[ExcludedRootV1],
    disposition: &str,
) {
    target.extend(source.iter().map(|entry| PlanExclusionV1 {
        name: entry.name.clone(),
        disposition: disposition.to_string(),
        reason: entry.reason.clone(),
    }));
}

fn canonical_plan_bytes(plan: &LocalBuildPlanV1) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(plan)
        .map_err(|error| format!("serialize local build plan: {error}"))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn graph_authority_bytes(authority: &GraphAuthorityV1) -> Result<Vec<u8>, String> {
    canonical_json_bytes(authority)
        .map_err(|error| format!("serialize local-build graph authority: {error}"))
}

fn source_only_program_projection_candidate(
    projection: ProgramPackageIndex,
    graph_authority_sha256: &str,
    receipts: &BTreeMap<PlanNodeV1, PackageNodeReceiptV1>,
    root_mirror_nodes: &BTreeSet<PlanNodeV1>,
) -> Result<SourceOnlyProgramProjectionV1, String> {
    require_lowercase_sha256(graph_authority_sha256, "graph authority")?;
    if projection.format != "kandelo-program-packages-v2" {
        return Err(format!(
            "source-only program projection has unexpected v2 format {:?}",
            projection.format
        ));
    }
    let mut required_identities = projection.packages.keys().cloned().collect::<BTreeSet<_>>();
    for package in projection.packages.values() {
        for dependency in package.dependency_closures.values().flatten() {
            required_identities.insert(dependency.package_name.clone());
        }
    }
    if projection.identities.keys().cloned().collect::<BTreeSet<_>>() != required_identities {
        return Err(
            "source-only v2 identities must be the exact package/dependency identity set"
                .to_string(),
        );
    }

    let mut nodes = Vec::new();
    let mut ordinary_program_nodes = BTreeSet::new();
    for (name, package) in &projection.packages {
        let identity = projection.identities.get(name).ok_or_else(|| {
            format!("source-only v2 program {name:?} has no package identity")
        })?;
        if identity.manifest_sha256 != package.manifest_sha256 {
            return Err(format!(
                "source-only v2 program {name:?} manifest identity does not match its package projection"
            ));
        }
        let mut sorted_arches = package.arches.clone();
        sorted_arches.sort();
        sorted_arches.dedup();
        if sorted_arches != package.arches {
            return Err(format!(
                "source-only v2 program {name:?} architectures are not sorted and unique"
            ));
        }
        let expected_arches = package.arches.iter().cloned().collect::<BTreeSet<_>>();
        if package.cache_keys.keys().cloned().collect::<BTreeSet<_>>() != expected_arches
            || package
                .dependency_closures
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>()
                != expected_arches
        {
            return Err(format!(
                "source-only v2 program {name:?} architecture maps do not match its selected architectures"
            ));
        }

        for target_arch in &package.arches {
            if !matches!(target_arch.as_str(), "wasm32" | "wasm64") {
                return Err(format!(
                    "source-only v2 program {name:?} has unsupported architecture {target_arch:?}"
                ));
            }
            let cache_key_sha256 = package.cache_keys.get(target_arch).ok_or_else(|| {
                format!(
                    "source-only v2 program {name:?} omitted cache key for {target_arch}"
                )
            })?;
            require_lowercase_sha256(cache_key_sha256, "source-only v2 cache key")?;
            if identity.cache_keys.get(target_arch) != Some(cache_key_sha256) {
                return Err(format!(
                    "source-only v2 program {name:?}/{target_arch} package and identity cache keys differ"
                ));
            }
            let plan_node = PlanNodeV1::package(name, target_arch);
            ordinary_program_nodes.insert(plan_node.clone());
            let receipt = receipts.get(&plan_node).ok_or_else(|| {
                format!(
                    "successful source-only program {name:?}/{target_arch} omitted its retained package receipt"
                )
            })?;
            require_lowercase_sha256(&receipt.manifest_sha256, "package manifest receipt")?;
            require_lowercase_sha256(&receipt.cache_key_sha256, "package cache-key receipt")?;
            require_lowercase_sha256(
                &receipt.cache_receipt_sha256,
                "package cache-tree receipt",
            )?;
            if receipt.manifest_sha256 != package.manifest_sha256 {
                return Err(format!(
                    "source-only program {name:?}/{target_arch} manifest receipt does not match v2 projection"
                ));
            }
            if &receipt.cache_key_sha256 != cache_key_sha256 {
                return Err(format!(
                    "source-only program {name:?}/{target_arch} cache key receipt does not match v2 projection"
                ));
            }

            let mut sorted_members = receipt.materialized_members.clone();
            sorted_members.sort_by(|left, right| {
                (&left.mirror_path, &left.source_artifact)
                    .cmp(&(&right.mirror_path, &right.source_artifact))
            });
            if sorted_members != receipt.materialized_members {
                return Err(format!(
                    "source-only program {name:?}/{target_arch} member receipt is not canonically sorted"
                ));
            }
            if sorted_members.len() != package.members.len() {
                return Err(format!(
                    "source-only program {name:?}/{target_arch} member receipt count does not match v2 projection"
                ));
            }
            let mut receipt_members = BTreeMap::new();
            for member in &sorted_members {
                require_lowercase_sha256(&member.sha256, "materialized member digest")?;
                if member.size > SOURCE_ONLY_PROGRAM_MEMBER_LIMIT {
                    return Err(format!(
                        "source-only program {name:?}/{target_arch} exceeds the 512 MiB member limit at {:?}",
                        member.mirror_path
                    ));
                }
                let key = (&member.mirror_path, &member.source_artifact);
                if receipt_members.insert(key, member).is_some() {
                    return Err(format!(
                        "source-only program {name:?}/{target_arch} repeats a materialized member receipt"
                    ));
                }
            }
            for member in &package.members {
                let expected_mirror_path =
                    format!("programs/{target_arch}/{}", member.mirror_path);
                let actual = receipt_members
                    .get(&(&expected_mirror_path, &member.source_artifact))
                    .ok_or_else(|| {
                        format!(
                            "source-only program {name:?}/{target_arch} receipt omitted declared member {:?} at {:?}",
                            member.source_artifact, expected_mirror_path
                        )
                    })?;
                if member.mode.is_some_and(|mode| actual.mode != mode) {
                    return Err(format!(
                        "source-only program {name:?}/{target_arch} materialized mode for {:?} does not match v2 declaration",
                        member.source_artifact
                    ));
                }
            }

            nodes.push(SourceOnlyProgramNodeV1 {
                node: SourceOnlyProgramNodeIdentityV1 {
                    kind: "package",
                    name: name.clone(),
                    target_arch: target_arch.clone(),
                },
                manifest_sha256: receipt.manifest_sha256.clone(),
                cache_key_sha256: receipt.cache_key_sha256.clone(),
                cache_receipt_sha256: receipt.cache_receipt_sha256.clone(),
                members: sorted_members,
            });
        }
    }

    for root_node in root_mirror_nodes {
        let PlanNodeV1::Package { name, target_arch } = root_node else {
            return Err("source-only root-mirror set contains a product node".to_string());
        };
        if !matches!(name.as_str(), "kernel") {
            return Err(format!(
                "source-only root-mirror package must be only kernel, got {name:?}/{target_arch}"
            ));
        }
        if projection.packages.contains_key(name) || ordinary_program_nodes.contains(root_node) {
            return Err(format!(
                "source-only root-mirror package {name:?}/{target_arch} is also present in the ordinary v2 program projection"
            ));
        }
        if !matches!(target_arch.as_str(), "wasm32" | "wasm64") {
            return Err(format!(
                "source-only root-mirror package {name:?} has unsupported architecture {target_arch:?}"
            ));
        }
        let receipt = receipts.get(root_node).ok_or_else(|| {
            format!(
                "successful source-only root-mirror package {name:?}/{target_arch} omitted its retained package receipt"
            )
        })?;
        require_lowercase_sha256(&receipt.manifest_sha256, "root-mirror manifest receipt")?;
        require_lowercase_sha256(&receipt.cache_key_sha256, "root-mirror cache-key receipt")?;
        require_lowercase_sha256(
            &receipt.cache_receipt_sha256,
            "root-mirror cache-tree receipt",
        )?;
        if let Some(identity) = projection.identities.get(name) {
            if identity.manifest_sha256 != receipt.manifest_sha256
                || identity.cache_keys.get(target_arch) != Some(&receipt.cache_key_sha256)
            {
                return Err(format!(
                    "source-only root-mirror package {name:?}/{target_arch} does not match its optional v2 identity"
                ));
            }
        }
        let mut members = receipt.materialized_members.clone();
        members.sort_by(|left, right| {
            (&left.mirror_path, &left.source_artifact)
                .cmp(&(&right.mirror_path, &right.source_artifact))
        });
        if members != receipt.materialized_members {
            return Err(format!(
                "source-only root-mirror package {name:?}/{target_arch} member receipt must be canonically sorted"
            ));
        }
        if members.len() != 1
            || members[0].mirror_path.contains('/')
            || members[0].mirror_path.contains('\\')
        {
            return Err(format!(
                "source-only root-mirror package {name:?}/{target_arch} must have exactly one root-level member"
            ));
        }
        let mut identities = BTreeSet::new();
        for member in &members {
            validate_relative_path(
                &member.mirror_path,
                "source-only root-mirror materialized path",
            )?;
            validate_relative_path(
                &member.source_artifact,
                "source-only root-mirror source artifact",
            )?;
            require_lowercase_sha256(&member.sha256, "root-mirror materialized digest")?;
            if member.size > SOURCE_ONLY_PROGRAM_MEMBER_LIMIT {
                return Err(format!(
                    "source-only root-mirror package {name:?}/{target_arch} exceeds the 512 MiB member limit at {:?}",
                    member.mirror_path
                ));
            }
            if !identities.insert((&member.mirror_path, &member.source_artifact)) {
                return Err(format!(
                    "source-only root-mirror package {name:?}/{target_arch} repeats a materialized member receipt"
                ));
            }
        }
        nodes.push(SourceOnlyProgramNodeV1 {
            node: SourceOnlyProgramNodeIdentityV1 {
                kind: "package",
                name: name.clone(),
                target_arch: target_arch.clone(),
            },
            manifest_sha256: receipt.manifest_sha256.clone(),
            cache_key_sha256: receipt.cache_key_sha256.clone(),
            cache_receipt_sha256: receipt.cache_receipt_sha256.clone(),
            members,
        });
    }
    nodes.sort_by(|left, right| {
        (&left.node.name, &left.node.target_arch).cmp(&(
            &right.node.name,
            &right.node.target_arch,
        ))
    });

    Ok(SourceOnlyProgramProjectionV1 {
        format: SOURCE_ONLY_PROGRAM_PROJECTION_FORMAT,
        projection,
        graph_authority_sha256: graph_authority_sha256.to_string(),
        nodes,
    })
}

fn source_only_program_projection_bytes(
    authority: &SourceOnlyProgramProjectionV1,
) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec_pretty(authority)
        .map_err(|error| format!("serialize source-only program projection authority: {error}"))?;
    bytes.push(b'\n');
    if bytes.len() > SOURCE_ONLY_PROGRAM_PROJECTION_LIMIT {
        return Err(format!(
            "source-only program projection authority is {} bytes, exceeding the {}-byte limit",
            bytes.len(),
            SOURCE_ONLY_PROGRAM_PROJECTION_LIMIT,
        ));
    }
    Ok(bytes)
}

fn require_lowercase_sha256(value: &str, label: &str) -> Result<(), String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!(
            "{label} must be exactly 64 lowercase hexadecimal characters"
        ));
    }
    Ok(())
}

pub(crate) fn canonical_machine_json<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    canonical_json_bytes(value)
        .map_err(|error| format!("serialize local-build machine result: {error}"))
}

#[derive(Default)]
struct ParsedFlagsV1 {
    values: BTreeMap<String, String>,
    repeated: BTreeMap<String, Vec<String>>,
    switches: BTreeSet<String>,
}

fn parse_local_build_args_with_jobs(
    args: &[String],
    environment_jobs: Option<&str>,
    available_jobs: Option<std::num::NonZeroUsize>,
) -> Result<LocalBuildCommandV1, String> {
    let (command, rest) = args
        .split_first()
        .ok_or_else(|| "usage: xtask local-build <plan|run|run-node> ...".to_string())?;
    match command.as_str() {
        "plan" => {
            let mut flags = parse_named_flags(rest, &["--set"], &[], &[])?;
            Ok(LocalBuildCommandV1::Plan {
                set: PathBuf::from(take_required_flag(&mut flags, "--set")?),
            })
        }
        "run" => {
            let mut flags = parse_named_flags(
                rest,
                &["--set", "--source-cache-root", "--output-root", "--jobs"],
                &["--product"],
                &["--rebuild", "--verify-cache"],
            )?;
            let set = PathBuf::from(take_required_flag(&mut flags, "--set")?);
            let source_cache_root = absolute_authored_path(
                take_required_flag(&mut flags, "--source-cache-root")?,
                "--source-cache-root",
            )?;
            let output_root = absolute_authored_path(
                take_required_flag(&mut flags, "--output-root")?,
                "--output-root",
            )?;
            let products = flags.repeated.remove("--product").unwrap_or_default();
            let mut unique = BTreeSet::new();
            for product in &products {
                if product != "all" {
                    validate_name(product, "product filter")?;
                }
                if !unique.insert(product.as_str()) {
                    return Err(format!("repeated --product value {product:?}"));
                }
            }
            if unique.contains("all") && unique.len() != 1 {
                return Err("--product all may not be mixed with product IDs".to_string());
            }
            let explicit_jobs = flags.values.remove("--jobs");
            let jobs =
                select_job_count(explicit_jobs.as_deref(), environment_jobs, available_jobs)?;
            Ok(LocalBuildCommandV1::Run(LocalBuildRunArgsV1 {
                set,
                source_cache_root,
                output_root,
                products,
                jobs,
                rebuild: flags.switches.remove("--rebuild"),
                verify_cache: flags.switches.remove("--verify-cache"),
            }))
        }
        "run-node" => {
            let mut flags = parse_named_flags(
                rest,
                &[
                    "--repo-root",
                    "--set",
                    "--graph-authority-sha256",
                    "--source-cache-root",
                    "--compiled-cache-root",
                    "--output-root",
                    "--node-kind",
                    "--package",
                    "--target-arch",
                    "--product",
                    "--result-json",
                ],
                &[],
                &["--rebuild", "--verify-cache"],
            )?;
            let repo_root = absolute_authored_path(
                take_required_flag(&mut flags, "--repo-root")?,
                "--repo-root",
            )?;
            let set = absolute_authored_path(take_required_flag(&mut flags, "--set")?, "--set")?;
            let graph_authority_sha256 =
                take_required_flag(&mut flags, "--graph-authority-sha256")?;
            if graph_authority_sha256.len() != 64
                || !graph_authority_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(
                    "--graph-authority-sha256 must be exactly 64 lowercase hexadecimal characters"
                        .to_string(),
                );
            }
            let source_cache_root = absolute_authored_path(
                take_required_flag(&mut flags, "--source-cache-root")?,
                "--source-cache-root",
            )?;
            let compiled_cache_root = absolute_authored_path(
                take_required_flag(&mut flags, "--compiled-cache-root")?,
                "--compiled-cache-root",
            )?;
            let output_root = absolute_authored_path(
                take_required_flag(&mut flags, "--output-root")?,
                "--output-root",
            )?;
            let result_json = absolute_authored_path(
                take_required_flag(&mut flags, "--result-json")?,
                "--result-json",
            )?;
            let node_kind = take_required_flag(&mut flags, "--node-kind")?;
            let node = match node_kind.as_str() {
                "package" => {
                    if flags.values.contains_key("--product") {
                        return Err("package run-node forbids --product".to_string());
                    }
                    let package = take_required_flag(&mut flags, "--package")?;
                    validate_name(&package, "package node")?;
                    let target_arch = take_required_flag(&mut flags, "--target-arch")?;
                    if !matches!(target_arch.as_str(), "wasm32" | "wasm64") {
                        return Err(format!(
                            "--target-arch must be wasm32 or wasm64, got {target_arch:?}"
                        ));
                    }
                    PlanNodeV1::package(&package, &target_arch)
                }
                "product" => {
                    if flags.values.contains_key("--package")
                        || flags.values.contains_key("--target-arch")
                    {
                        return Err(
                            "product run-node forbids --package and --target-arch".to_string()
                        );
                    }
                    let product = take_required_flag(&mut flags, "--product")?;
                    validate_name(&product, "product node")?;
                    PlanNodeV1::product(&product)
                }
                _ => {
                    return Err(format!(
                        "--node-kind must be package or product, got {node_kind:?}"
                    ));
                }
            };
            Ok(LocalBuildCommandV1::RunNode(LocalBuildRunNodeArgsV1 {
                repo_root,
                set,
                graph_authority_sha256,
                source_cache_root,
                compiled_cache_root,
                output_root,
                node,
                result_json,
                rebuild: flags.switches.remove("--rebuild"),
                verify_cache: flags.switches.remove("--verify-cache"),
            }))
        }
        _ => Err(format!("unknown local-build subcommand {command:?}")),
    }
}

fn parse_named_flags(
    args: &[String],
    singleton_values: &[&str],
    repeated_values: &[&str],
    switches: &[&str],
) -> Result<ParsedFlagsV1, String> {
    let singleton_values = singleton_values.iter().copied().collect::<BTreeSet<_>>();
    let repeated_values = repeated_values.iter().copied().collect::<BTreeSet<_>>();
    let switches = switches.iter().copied().collect::<BTreeSet<_>>();
    let mut parsed = ParsedFlagsV1::default();
    let mut index = 0usize;
    while index < args.len() {
        let token = &args[index];
        if !token.starts_with("--") {
            return Err(format!(
                "unexpected positional local-build argument {token:?}"
            ));
        }
        let (flag, inline_value) = match token.split_once('=') {
            Some((flag, value)) => (flag, Some(value)),
            None => (token.as_str(), None),
        };
        if switches.contains(flag) {
            if inline_value.is_some() {
                return Err(format!("switch {flag} does not accept a value"));
            }
            if !parsed.switches.insert(flag.to_string()) {
                return Err(format!("duplicate switch {flag}"));
            }
            index += 1;
            continue;
        }
        if !singleton_values.contains(flag) && !repeated_values.contains(flag) {
            return Err(format!("unknown local-build flag {flag:?}"));
        }
        let value = if let Some(value) = inline_value {
            value.to_string()
        } else {
            index += 1;
            let value = args
                .get(index)
                .filter(|value| !value.starts_with("--"))
                .ok_or_else(|| format!("flag {flag} requires a value"))?;
            value.clone()
        };
        if value.is_empty() {
            return Err(format!("flag {flag} requires a nonempty value"));
        }
        if singleton_values.contains(flag) {
            if parsed.values.insert(flag.to_string(), value).is_some() {
                return Err(format!("duplicate singleton flag {flag}"));
            }
        } else {
            parsed
                .repeated
                .entry(flag.to_string())
                .or_default()
                .push(value);
        }
        index += 1;
    }
    Ok(parsed)
}

fn take_required_flag(flags: &mut ParsedFlagsV1, flag: &str) -> Result<String, String> {
    flags
        .values
        .remove(flag)
        .ok_or_else(|| format!("missing required local-build flag {flag}"))
}

fn absolute_authored_path(value: String, flag: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(&value);
    if !path.is_absolute() {
        return Err(format!("{flag} must be absolute, got {value:?}"));
    }
    Ok(path)
}

fn select_job_count(
    explicit: Option<&str>,
    environment: Option<&str>,
    available: Option<std::num::NonZeroUsize>,
) -> Result<usize, String> {
    if let Some(value) = explicit {
        return parse_positive_job_count(value, "--jobs");
    }
    if let Some(value) = environment {
        return parse_positive_job_count(value, "WASM_POSIX_LOCAL_BUILD_JOBS");
    }
    Ok(available.map(std::num::NonZeroUsize::get).unwrap_or(1))
}

fn parse_positive_job_count(value: &str, source: &str) -> Result<usize, String> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(format!(
            "{source} must be an exact positive integer, got {value:?}"
        ));
    }
    let jobs = value
        .parse::<usize>()
        .map_err(|_| format!("{source} positive integer overflows usize: {value:?}"))?;
    if jobs == 0 {
        return Err(format!("{source} must be greater than zero"));
    }
    Ok(jobs)
}

pub(crate) fn ansi_enabled(stderr_is_terminal: bool, no_color_is_present: bool) -> bool {
    stderr_is_terminal && !no_color_is_present
}

pub(crate) fn render_lifecycle_token(token: LifecycleTokenV1, color: bool) -> String {
    let (word, ansi) = match token {
        LifecycleTokenV1::Ready => ("READY", 34),
        LifecycleTokenV1::Queued => ("QUEUED", 34),
        LifecycleTokenV1::Running => ("RUNNING", 36),
        LifecycleTokenV1::Continuing => ("CONTINUING", 36),
        LifecycleTokenV1::Cached => ("CACHED", 32),
        LifecycleTokenV1::Reused => ("REUSED", 32),
        LifecycleTokenV1::Succeeded => ("SUCCEEDED", 32),
        LifecycleTokenV1::Blocked => ("BLOCKED", 33),
        LifecycleTokenV1::Failed => ("FAILED", 31),
    };
    if color {
        format!("\u{1b}[{ansi}m{word}\u{1b}[0m")
    } else {
        word.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_deps::Registry;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn source_cache_root_defaults_to_home_when_no_override() {
        let resolved =
            resolve_source_cache_root(None, Some(std::ffi::OsString::from("/home/dev"))).unwrap();
        assert_eq!(resolved, PathBuf::from("/home/dev/.cache/kandelo/source-only"));
    }

    #[test]
    fn source_cache_root_override_wins_over_home() {
        let resolved = resolve_source_cache_root(
            Some(std::ffi::OsString::from("/tmp/wt-cache")),
            Some(std::ffi::OsString::from("/home/dev")),
        )
        .unwrap();
        assert_eq!(resolved, PathBuf::from("/tmp/wt-cache"));
    }

    #[test]
    fn source_cache_root_override_must_be_absolute() {
        let err = resolve_source_cache_root(
            Some(std::ffi::OsString::from("relative/cache")),
            Some(std::ffi::OsString::from("/home/dev")),
        )
        .unwrap_err();
        assert!(err.contains("KANDELO_SOURCE_CACHE_ROOT"), "{err}");
        assert!(err.contains("absolute"), "{err}");
    }

    #[test]
    fn source_cache_root_errors_when_no_override_and_no_home() {
        let err = resolve_source_cache_root(None, None).unwrap_err();
        assert!(err.contains("HOME is not set"), "{err}");
    }

    #[test]
    fn source_only_program_projection_is_current_matches_recorded_graph_authority() {
        let temp = tempfile::TempDir::new().unwrap();
        let output = temp.path();
        let authority = "a".repeat(64);

        assert!(
            !source_only_program_projection_is_current(output, &authority),
            "an absent projection authority is never current"
        );

        let path = output
            .join(".kandelo")
            .join("source-only-program-projection-v1.json");
        write(
            &path,
            &format!(r#"{{"graphAuthoritySha256":"{authority}","nodes":[]}}"#),
        );

        assert!(
            source_only_program_projection_is_current(output, &authority),
            "a projection recording the same graph authority is current"
        );
        assert!(
            !source_only_program_projection_is_current(output, &"b".repeat(64)),
            "a projection recording a different graph authority is stale"
        );
    }

    fn package(root: &Path, name: &str, arches: &[&str], dependencies: &[(&str, &str)]) {
        let arches = if arches.is_empty() {
            String::new()
        } else {
            format!(
                "arches = [{}]\n",
                arches
                    .iter()
                    .map(|arch| format!("\"{arch}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let depends_on = dependencies
            .iter()
            .map(|(dependency, version)| format!("\"{dependency}@{version}\""))
            .collect::<Vec<_>>()
            .join(", ");
        write(
            &root
                .join("packages/registry")
                .join(name)
                .join("package.toml"),
            &format!(
                "kind = \"program\"\nname = \"{name}\"\nversion = \"1.0.0\"\nkernel_abi = 7\n{arches}depends_on = [{depends_on}]\n\n[source]\nurl = \"https://example.invalid/{name}\"\nsha256 = \"0000000000000000000000000000000000000000000000000000000000000000\"\nprovider = \"repository\"\n\n[license]\nspdx = \"MIT\"\n\n[build]\nscript_path = \"packages/registry/{name}/build-{name}.sh\"\n\n[[outputs]]\nname = \"{name}\"\nwasm = \"{name}.wasm\"\n"
            ),
        );
        write(
            &root
                .join("packages/registry")
                .join(name)
                .join(format!("build-{name}.sh")),
            "#!/bin/sh\n",
        );
        write(
            &root.join("packages/registry").join(name).join("build.toml"),
            &format!(
                "script_path = \"packages/registry/{name}/build-{name}.sh\"\ninputs = [\"packages/registry/{name}/build-{name}.sh\"]\nrepo_url = \"https://example.invalid/kandelo.git\"\ncommit = \"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\"\nrevision = 1\n"
            ),
        );
    }

    fn source_package(root: &Path, name: &str) {
        write(
            &root
                .join("packages/registry")
                .join(name)
                .join("package.toml"),
            &format!(
                "kind = \"source\"\nname = \"{name}\"\nversion = \"1.0.0\"\n\n[source]\nurl = \"https://example.invalid/{name}.tar.gz\"\nsha256 = \"1111111111111111111111111111111111111111111111111111111111111111\"\nprovider = \"archive\"\n\n[license]\nspdx = \"MIT\"\n"
            ),
        );
    }

    fn product(root: &Path, id: &str, composed: &[&str]) -> PathBuf {
        product_with(root, id, "wasm32", composed, "")
    }

    fn product_with(
        root: &Path,
        id: &str,
        architecture: &str,
        composed: &[&str],
        additions: &str,
    ) -> PathBuf {
        let builder = format!("images/vfs/build-{id}.sh");
        write(&root.join(&builder), "#!/bin/sh\n");
        let composition = composed
            .iter()
            .map(|dependency| {
                format!(
                    "[[composition.product]]\nid = \"{dependency}\"\nmaterialization = \"embedded\"\n\n"
                )
            })
            .collect::<String>();
        let relative = PathBuf::from(format!("images/vfs/products/{id}.toml"));
        write(
            &root.join(&relative),
            &format!(
                "schema = 1\nid = \"{id}\"\narchitecture = \"{architecture}\"\noutput = \"{id}.vfs\"\nbuilder = \"{builder}\"\n\n{composition}{additions}[[mounts]]\npath = \"/\"\nsource = \"built-image\"\nreadonly = false\n"
            ),
        );
        relative
    }

    fn authority(
        root: &Path,
        packages: &[(&str, &str)],
        products: &[(&str, &str, &Path)],
        exclusions: &[(&str, &str)],
        dependency_only: &[&str],
    ) -> PathBuf {
        let mut source = String::from("schema = 1\npolicy = \"source-only-v1\"\n");
        for name in dependency_only {
            source.push_str(&format!("dependency_only = [\"{name}\"]\n"));
        }
        if dependency_only.is_empty() {
            source.push_str("dependency_only = []\n");
        }
        source.push_str("registry_non_roots = []\ndormant_products = []\n\n");
        if products.is_empty() {
            source.push_str("products = []\n");
        }
        if exclusions.is_empty() {
            source.push_str("exclusions = []\n");
        }
        if packages.is_empty() {
            source.push_str("packages = []\n");
        }
        for (name, class) in packages {
            source.push_str(&format!(
                "[[packages]]\nname = \"{name}\"\nclass = \"{class}\"\n\n"
            ));
        }
        for (id, package, manifest) in products {
            source.push_str(&format!(
                "[[products]]\nid = \"{id}\"\npackage = \"{package}\"\nmanifest = \"{}\"\n\n",
                manifest.display()
            ));
        }
        for (name, reason) in exclusions {
            source.push_str(&format!(
                "[[exclusions]]\nname = \"{name}\"\nreason = \"{reason}\"\n\n"
            ));
        }
        let path = root.join("packages/sets/local-supported.toml");
        write(&path, &source);
        path
    }

    fn declare_product_root_mirror_packages(
        set: &Path,
        id: &str,
        package: &str,
        manifest: &Path,
        root_mirror_packages: &[&str],
    ) {
        let original = fs::read_to_string(set).unwrap();
        let binding = format!(
            "id = \"{id}\"\npackage = \"{package}\"\nmanifest = \"{}\"\n",
            manifest.display(),
        );
        let packages = root_mirror_packages
            .iter()
            .map(|name| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let replacement = format!("{binding}root_mirror_packages = [{packages}]\n");
        assert!(original.contains(&binding));
        write(set, &original.replacen(&binding, &replacement, 1));
    }

    fn registry(root: &Path) -> Registry {
        Registry {
            roots: vec![root.join("packages/registry")],
        }
    }

    #[test]
    fn clean_cascades_to_products_embedding_the_package() {
        // Real checked-in graph: nethack <- nethack-browser-bundle <- shell
        // <- the browser-main-shell product (packages/registry/shell/
        // package.toml depends on nethack-browser-bundle; local-supported
        // .toml's browser-main-shell product maps to the shell package).
        // `clean_removal_set` must discover this by walking dependency
        // edges backwards from `nethack` — not by consulting any hand-kept
        // list of "packages that live inside the shell VFS image".
        let repo = crate::repo_root();
        let set = repo.join("packages/sets/local-supported.toml");
        let registry = Registry::from_env(&repo);
        let graph = load_and_plan(&repo, &set, &registry).unwrap();

        let nethack = PlanNodeV1::package("nethack", "wasm32");
        let removal = clean_removal_set(&graph, &nethack);

        assert!(
            removal.contains(&nethack),
            "the removal set always includes the cleaned node itself"
        );
        assert!(
            removal.contains(&PlanNodeV1::package("nethack-browser-bundle", "wasm32")),
            "cleaning nethack invalidates the bundle package that directly depends on it"
        );
        assert!(
            removal.contains(&PlanNodeV1::package("shell", "wasm32")),
            "cleaning nethack invalidates the shell package that embeds the bundle"
        );
        assert!(
            removal
                .iter()
                .any(|node| matches!(node, PlanNodeV1::Product { id } if id.contains("shell"))),
            "cleaning nethack invalidates the shell product that embeds it; got {removal:?}",
        );

        // A leaf nothing else depends on (directly or via a product) removes
        // only itself. Read the leaf out of the graph's real node set instead
        // of naming one: a named package stops being a leaf as soon as an image
        // embeds it. Iterating the actual package nodes (rather than
        // reconstructing them from names under a hardcoded arch) keeps the
        // candidate honest for any planned target, so the leaf we assert on is
        // one the graph truly contains.
        let leaf = graph
            .dependencies
            .keys()
            .filter(|node| matches!(node, PlanNodeV1::Package { .. }))
            .find(|node| !graph.dependencies.values().any(|deps| deps.contains(node)))
            .cloned()
            .expect("the checked-in graph has a package nothing else depends on");
        assert_eq!(
            clean_removal_set(&graph, &leaf),
            BTreeSet::from([leaf.clone()])
        );
    }

    /// Fabricate one compiled `SourceOnlyV1` generation exactly the way the
    /// real engine leaves one on disk: a canonical cache directory under
    /// `<compiled_cache_root>/programs/`, its hidden receipt sidecar (via
    /// the real `write_source_only_cache_receipt`, so the sidecar's name and
    /// shape match what `clean_package_node_outputs` actually reads), and
    /// the one file the receipt's `materialized_members` mirrors into
    /// `output_root`. Returns the canonical generation directory path.
    fn fabricate_compiled_generation(
        compiled_cache_root: &Path,
        output_root: &Path,
        name: &str,
        version: &str,
        revision: u32,
        arch: &str,
        cache_key_sha: &str,
        mirror_relative: &str,
    ) -> PathBuf {
        let basename = format!("{name}-{version}-rev{revision}-{arch}-{cache_key_sha}");
        let canonical = compiled_cache_root.join("programs").join(&basename);
        fs::create_dir_all(&canonical).unwrap();
        fs::write(canonical.join("marker"), b"fixture generation").unwrap();

        let mirror = output_root.join(mirror_relative);
        write(&mirror, "fixture mirrored output");

        let receipt = PackageNodeReceiptV1 {
            manifest_sha256: "0".repeat(64),
            cache_key_sha256: cache_key_sha.to_string(),
            cache_receipt_sha256: "1".repeat(64),
            materialized_members: vec![MaterializedProgramMemberV1 {
                source_artifact: format!("{name}.wasm"),
                mirror_path: mirror_relative.to_string(),
                mode: 0o755,
                size: fs::metadata(&mirror).unwrap().len(),
                sha256: "2".repeat(64),
            }],
        };
        crate::build_deps::write_source_only_cache_receipt(&canonical, &receipt).unwrap();
        canonical
    }

    #[test]
    fn clean_package_node_outputs_removes_only_the_targeted_generation() {
        // This is the destructive path `xtask clean` actually runs: it must
        // remove exactly the targeted package's compiled cache directory,
        // its receipt sidecar, and its mirrored output — and must NOT touch
        // an unrelated sibling package's cache/receipt/mirror, however
        // similar the on-disk layout looks. A live run proved this once by
        // hand (see the Stage 5 report); this pins it as a fast, repeatable
        // tmpdir test instead of relying on that again.
        let root = tempfile::TempDir::new().unwrap();
        let root = root.path();
        package(root, "alpha", &[], &[]);
        package(root, "beta", &[], &[]);
        let reg = registry(root);

        let cache = tempfile::TempDir::new().unwrap();
        let compiled_cache_root = cache.path().join("compiled");
        let output = tempfile::TempDir::new().unwrap();
        let output_root = output.path();

        let alpha_cache_key = "cachekey-alpha-0000000000000000000000000000000000000000";
        let beta_cache_key = "cachekey-beta-00000000000000000000000000000000000000000";
        let alpha_canonical = fabricate_compiled_generation(
            &compiled_cache_root,
            output_root,
            "alpha",
            "1.0.0",
            1,
            "wasm32",
            alpha_cache_key,
            "programs/wasm32/alpha.wasm",
        );
        let beta_canonical = fabricate_compiled_generation(
            &compiled_cache_root,
            output_root,
            "beta",
            "1.0.0",
            1,
            "wasm32",
            beta_cache_key,
            "programs/wasm32/beta.wasm",
        );
        let alpha_receipt_sidecar =
            crate::build_deps::source_only_cache_receipt_path(&alpha_canonical, alpha_cache_key)
                .unwrap();
        let beta_receipt_sidecar =
            crate::build_deps::source_only_cache_receipt_path(&beta_canonical, beta_cache_key)
                .unwrap();
        let alpha_mirror = output_root.join("programs/wasm32/alpha.wasm");
        let beta_mirror = output_root.join("programs/wasm32/beta.wasm");

        // Sanity: the fixture actually created everything the assertions
        // below check the disappearance/survival of.
        assert!(alpha_canonical.is_dir());
        assert!(beta_canonical.is_dir());
        assert!(alpha_receipt_sidecar.is_file());
        assert!(beta_receipt_sidecar.is_file());
        assert!(alpha_mirror.is_file());
        assert!(beta_mirror.is_file());

        let removed =
            clean_package_node_outputs(&reg, &compiled_cache_root, output_root, "alpha", "wasm32")
                .unwrap();
        assert!(
            removed.contains(&alpha_canonical)
                && removed.contains(&alpha_receipt_sidecar)
                && removed.contains(&alpha_mirror),
            "expected the targeted generation dir, receipt sidecar, and mirror in the removed list; got {removed:?}"
        );

        assert!(
            !alpha_canonical.exists(),
            "targeted generation directory must be removed"
        );
        assert!(
            !alpha_receipt_sidecar.exists(),
            "targeted receipt sidecar must be removed"
        );
        assert!(
            !alpha_mirror.exists(),
            "targeted mirrored output must be removed"
        );

        assert!(
            beta_canonical.is_dir(),
            "decoy sibling's generation directory must survive"
        );
        assert!(
            beta_receipt_sidecar.is_file(),
            "decoy sibling's receipt sidecar must survive"
        );
        assert!(
            beta_mirror.is_file(),
            "decoy sibling's mirrored output must survive"
        );
    }

    /// Extract the body (inclusive of the enclosing braces) of a top-level
    /// bash function named `function` from `source`, by counting brace
    /// depth from the function's opening `{`. Good enough for the small,
    /// brace-free-besides-`${...}` bodies this file's folded `build_*_vfs`
    /// functions have today; not a general bash parser.
    fn extract_bash_function_body(source: &str, function: &str) -> String {
        let header = format!("{function}() {{");
        let start = source
            .find(&header)
            .unwrap_or_else(|| panic!("run.sh: no {header:?} function definition found"));
        let mut depth = 0i32;
        let mut end = None;
        for (offset, ch) in source[start..].char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(start + offset + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        let end = end
            .unwrap_or_else(|| panic!("run.sh: unterminated body for function {function:?}"));
        source[start..end].to_string()
    }

    /// Whether `body` contains a real `bootstrap_target <id>` call — not
    /// just `id` as a substring of a longer, differently-named id (so a
    /// `browser-nginx-php` body doesn't falsely satisfy an expectation of
    /// `browser-nginx`).
    fn body_calls_bootstrap_target(body: &str, id: &str) -> bool {
        let needle = format!("bootstrap_target {id}");
        let mut search_from = 0;
        while let Some(relative) = body[search_from..].find(&needle) {
            let match_end = search_from + relative + needle.len();
            let boundary_ok = body[match_end..]
                .chars()
                .next()
                .map(|next| !(next.is_alphanumeric() || next == '-' || next == '_'))
                .unwrap_or(true);
            if boundary_ok {
                return true;
            }
            search_from = search_from + relative + 1;
        }
        false
    }

    /// Assert that `run.sh`'s `<function>` body actually dispatches to
    /// `bootstrap_target <expected_id>`. This is the run.sh-side half of the
    /// Stage 4 anti-drift guard: `run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries`
    /// below only checks that `expected_id` is a declared product/package in
    /// `local-supported.toml` — it says nothing about what `run.sh` actually
    /// does. Without this, routing `build_wp_vfs` to the wrong product
    /// (e.g. `browser-lamp` instead of `browser-wordpress`), or reverting a
    /// folded function back to its old inline bash body, would both still
    /// pass that check.
    fn assert_run_sh_folded_dispatch(run_sh_source: &str, function: &str, expected_id: &str) {
        let body = extract_bash_function_body(run_sh_source, function);
        assert!(
            body_calls_bootstrap_target(&body, expected_id),
            "run.sh's {function}() does not call `bootstrap_target {expected_id}`; \
             body was:\n{body}",
        );
    }

    /// Stage 4 gap enumeration: every `build_*_vfs` function `run.sh` defines
    /// must be accounted for as either (a) folded into a declared
    /// `[[products]]` id (or, for `mariadb-test`, a declared bare package —
    /// see its comment below) that `xtask bootstrap <id>` can already select,
    /// or (b) left as a bash builder because its underlying package/product
    /// is a documented, pre-existing exclusion/dormant entry that predates
    /// this fold and is out of scope to reactivate here. If a future edit
    /// declares a new product, removes an exclusion, or adds a new
    /// `build_*_vfs` function without updating this table, this test fails
    /// and forces the gap to be re-evaluated instead of silently drifting.
    #[test]
    fn run_sh_build_vfs_targets_are_folded_or_documented_bash_boundaries() {
        let repo = crate::repo_root();
        let set = parse_supported_set(&repo.join("packages/sets/local-supported.toml")).unwrap();
        let product_ids = declared_product_ids(&set);
        let package_names = set
            .packages
            .iter()
            .map(|package| package.name.as_str())
            .collect::<BTreeSet<_>>();
        let dormant_products = set
            .dormant_products
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<BTreeSet<_>>();
        let excluded = set
            .exclusions
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<BTreeSet<_>>();

        enum Expectation {
            /// Folded: `run.sh`'s `build_<fn>` delegates to
            /// `bootstrap_target <id>`, where `<id>` is a declared product id
            /// (`[[products]]`) or bare package name already selectable by
            /// `select_graph_dependencies`.
            FoldedProduct(&'static str),
            FoldedPackage(&'static str),
            /// Left as bash: `<excluded_name>` is the registry package or
            /// product id a pre-existing `[[exclusions]]`/`[[dormant_products]]`
            /// entry in `local-supported.toml` already keeps out of the
            /// engine's active graph, for a reason unrelated to whether the
            /// engine *could* model the composite (it already can — every
            /// one of these has a manifest and/or resolver-ready build
            /// script). Reactivating any of these is a product decision, not
            /// an engine-capability gap, and is out of Stage 4's scope.
            DormantOrExcluded(&'static str),
        }

        // run.sh function name -> what it should resolve to today.
        let table: &[(&str, Expectation)] = &[
            ("build_shell_vfs", Expectation::FoldedProduct("browser-main-shell")),
            ("build_wp_vfs", Expectation::FoldedProduct("browser-wordpress")),
            ("build_lamp_vfs", Expectation::FoldedProduct("browser-lamp")),
            ("build_nginx_vfs", Expectation::FoldedProduct("browser-nginx")),
            (
                "build_nginx_php_vfs",
                Expectation::FoldedProduct("browser-nginx-php"),
            ),
            ("build_node_vfs", Expectation::FoldedProduct("browser-node")),
    // mariadb-test has no `[[products]]` entry (matching the
            // sibling test-support manifests test-php.toml/test-sqlite.toml,
            // which are also manifest-only with no active product) but its
            // package is already declared and bootstraps the identical
            // build-mariadb-test.sh the bash builder called directly.
            ("build_mariadb_test_vfs", Expectation::FoldedPackage("mariadb-test")),
            // NOTE: keep this table's folded (fn, id) pairs and the
            // `run_sh_folded_dispatch_matches_this_table` loop below in sync
            // — the second loop reads run.sh itself and asserts that each
            // folded function's body literally calls
            // `bootstrap_target <id>` with the SAME id listed here, so a
            // routing typo/regression (wrong product, or a revert to inline
            // bash) fails even though local-supported.toml is untouched.
            ("build_mariadb_vfs", Expectation::DormantOrExcluded("mariadb-vfs")),
            ("build_mariadb64_vfs", Expectation::DormantOrExcluded("mariadb-vfs")),
            ("build_erlang_vfs", Expectation::DormantOrExcluded("erlang-vfs")),
            ("build_python_vfs", Expectation::DormantOrExcluded("python-vfs")),
            ("build_perl_vfs", Expectation::DormantOrExcluded("perl-vfs")),
            ("build_redis_vfs", Expectation::DormantOrExcluded("redis-vfs")),
            // texlive-vfs has no `[[products]]`/`[[packages]]` entry AND no
            // manifest under images/vfs/products at all (unlike the other
            // dormant composites, which at least have a written manifest);
            // its source package "texlive" is the excluded root.
            ("build_texlive_vfs", Expectation::DormantOrExcluded("texlive")),
        ];

        let run_sh_source = fs::read_to_string(repo.join("run.sh")).unwrap();

        for (function, expectation) in table {
            match expectation {
                Expectation::FoldedProduct(id) => {
                    assert!(
                        product_ids.contains(*id),
                        "{function} expects declared product {id:?}; \
                         declared_product_ids() = {product_ids:?}",
                    );
                    // toml-side declaration alone doesn't prove run.sh
                    // actually routes here — a wrong id, or a revert to the
                    // old inline bash body, would leave the assertion above
                    // passing. Read run.sh itself to close that gap.
                    assert_run_sh_folded_dispatch(&run_sh_source, function, id);
                }
                Expectation::FoldedPackage(name) => {
                    assert!(
                        package_names.contains(name),
                        "{function} expects declared package {name:?}; \
                         packages = {package_names:?}",
                    );
                    assert_run_sh_folded_dispatch(&run_sh_source, function, name);
                }
                Expectation::DormantOrExcluded(name) => assert!(
                    dormant_products.contains(name) || excluded.contains(name),
                    "{function} names {name:?}, expected to find it in \
                     dormant_products {dormant_products:?} or exclusions \
                     {excluded:?} — if it was removed from both, this \
                     composite is now foldable and this table (and \
                     run.sh's build_target routing) must be updated",
                ),
            }
        }

        // images/vfs/products/*.toml manifests exist for every dormant
        // composite except texlive (confirming Stage 4 left it bash for a
        // different, more fundamental reason: no manifest, no product/package
        // declaration, and its bash builder has a host-tool-availability
        // skip that isn't itself expressible as a manifest dependency).
        for id in ["browser-mariadb-wasm32", "browser-mariadb-wasm64", "browser-erlang", "browser-python", "browser-perl", "browser-redis"] {
            let manifest = repo.join("images/vfs/products").join(format!("{id}.toml"));
            assert!(manifest.is_file(), "expected dormant product manifest at {}", manifest.display());
        }
        assert!(
            !repo.join("images/vfs/products/texlive-vfs.toml").exists()
                && !repo.join("images/vfs/products/browser-texlive.toml").exists(),
            "texlive-vfs has no manifest today; if one is added, re-evaluate folding it",
        );
    }

    #[test]
    fn local_rebuild_graph_private_source_nodes_preserve_public_plan_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "app", &[], &[("archive-src", "1.0.0")]);
        source_package(root, "archive-src");
        product(root, "catalog-only", &[]);
        let set = authority(
            root,
            &[("app", "user-software")],
            &[],
            &[],
            &["archive-src"],
        );

        let graph = load_and_plan(root, &set, &registry(root)).unwrap();
        let app = PlanNodeV1::package("app", "wasm32");
        let source = PlanNodeV1::package("archive-src", "wasm32");
        assert_eq!(
            graph.dependencies,
            BTreeMap::from([
                (app.clone(), BTreeSet::from([source.clone()])),
                (source, BTreeSet::new()),
            ]),
        );

        let expected_public_plan = br#"{
  "schema": 1,
  "policy": "source-only-v1",
  "packages": [
    {
      "name": "app",
      "class": "user-software",
      "reason": "supported user-software root",
      "architectures": [
        "wasm32"
      ]
    }
  ],
  "products": [],
  "levels": [
    [
      {
        "kind": "package",
        "name": "app",
        "target_arch": "wasm32"
      }
    ]
  ],
  "exclusions": [
    {
      "name": "archive-src",
      "disposition": "dependency-only",
      "reason": "immutable source input; not a schedulable build root"
    }
  ]
}
"#;
        assert_eq!(
            canonical_plan_bytes(&graph.plan).unwrap(),
            expected_public_plan,
        );
    }

    #[test]
    fn local_rebuild_graph_product_package_claims_use_canonical_architecture_fallback() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "mapped", &["wasm64"], &[]);
        package(root, "exact", &["wasm64"], &[]);
        package(root, "fallback", &["wasm32"], &[]);
        let manifest = product_with(
            root,
            "app-product",
            "wasm64",
            &[],
            r#"[[software.package]]
name = "exact"
outputs = ["exact"]
source_roles = []
role = "runtime"
materialization = "embedded"

[[software.package]]
name = "fallback"
outputs = ["fallback"]
source_roles = []
role = "runtime"
materialization = "lazy"

"#,
        );
        let set = authority(
            root,
            &[
                ("mapped", "browser-product"),
                ("exact", "user-software"),
                ("fallback", "user-software"),
            ],
            &[("app-product", "mapped", manifest.as_path())],
            &[],
            &[],
        );

        let graph = load_and_plan(root, &set, &registry(root)).unwrap();
        assert_eq!(
            graph.dependencies[&PlanNodeV1::product("app-product")],
            BTreeSet::from([
                PlanNodeV1::package("exact", "wasm64"),
                PlanNodeV1::package("fallback", "wasm32"),
                PlanNodeV1::package("mapped", "wasm64"),
            ]),
        );
        assert!(graph.dependencies.keys().all(
            |node| !matches!(node, PlanNodeV1::Package { name, .. } if name == "not-a-package-edge")
        ),);
    }

    #[test]
    fn local_rebuild_graph_root_mirror_packages_select_kernel_for_filtered_product() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "mapped", &["wasm64"], &[]);
        package(root, "kernel", &["wasm32"], &[]);
        let manifest = product_with(root, "browser-app", "wasm64", &[], "");
        let set = authority(
            root,
            &[
                ("mapped", "browser-product"),
                ("kernel", "platform"),
            ],
            &[("browser-app", "mapped", manifest.as_path())],
            &[],
            &[],
        );
        declare_product_root_mirror_packages(
            &set,
            "browser-app",
            "mapped",
            &manifest,
            &["kernel"],
        );

        let graph = load_and_plan(root, &set, &registry(root)).unwrap();
        let product = PlanNodeV1::product("browser-app");
        let kernel = PlanNodeV1::package("kernel", "wasm32");
        assert_eq!(
            graph.dependencies[&product],
            BTreeSet::from([
                kernel.clone(),
                PlanNodeV1::package("mapped", "wasm64"),
            ]),
        );
        assert!(graph.authority.direct_edges.contains(&GraphDirectEdgeV1 {
            dependency: kernel.clone(),
            dependent: product.clone(),
        }));
        assert_eq!(
            select_graph_dependencies(&graph, &["browser-app".to_string()])
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                kernel,
                PlanNodeV1::package("mapped", "wasm64"),
                product,
            ]),
        );
    }

    #[test]
    fn local_rebuild_graph_rejects_invalid_root_mirror_package_declarations() {
        let excluded = tempfile::tempdir().unwrap();
        let excluded_root = excluded.path();
        package(excluded_root, "mapped", &[], &[]);
        package(excluded_root, "kernel", &[], &[]);
        let excluded_manifest = product(excluded_root, "excluded-product", &[]);
        let excluded_set = authority(
            excluded_root,
            &[("mapped", "browser-product")],
            &[("excluded-product", "mapped", excluded_manifest.as_path())],
            &[("kernel", "not selected")],
            &[],
        );
        declare_product_root_mirror_packages(
            &excluded_set,
            "excluded-product",
            "mapped",
            &excluded_manifest,
            &["kernel"],
        );
        let error = load_and_plan(excluded_root, &excluded_set, &registry(excluded_root))
            .unwrap_err();
        assert!(error.contains("selected buildable root"), "got: {error}");

        let ordinary = tempfile::tempdir().unwrap();
        let ordinary_root = ordinary.path();
        package(ordinary_root, "mapped", &[], &[]);
        package(ordinary_root, "helper", &[], &[]);
        let ordinary_manifest = product(ordinary_root, "ordinary-product", &[]);
        let ordinary_set = authority(
            ordinary_root,
            &[
                ("mapped", "browser-product"),
                ("helper", "platform"),
            ],
            &[("ordinary-product", "mapped", ordinary_manifest.as_path())],
            &[],
            &[],
        );
        declare_product_root_mirror_packages(
            &ordinary_set,
            "ordinary-product",
            "mapped",
            &ordinary_manifest,
            &["helper"],
        );
        let error = load_and_plan(ordinary_root, &ordinary_set, &registry(ordinary_root))
            .unwrap_err();
        assert!(error.contains("does not publish a root-mirror artifact"), "got: {error}");

        let duplicate = tempfile::tempdir().unwrap();
        let duplicate_root = duplicate.path();
        package(duplicate_root, "mapped", &[], &[]);
        package(duplicate_root, "kernel", &[], &[]);
        let duplicate_manifest = product(duplicate_root, "duplicate-product", &[]);
        let duplicate_set = authority(
            duplicate_root,
            &[
                ("mapped", "browser-product"),
                ("kernel", "platform"),
            ],
            &[("duplicate-product", "mapped", duplicate_manifest.as_path())],
            &[],
            &[],
        );
        declare_product_root_mirror_packages(
            &duplicate_set,
            "duplicate-product",
            "mapped",
            &duplicate_manifest,
            &["kernel", "kernel"],
        );
        let error = load_and_plan(duplicate_root, &duplicate_set, &registry(duplicate_root))
            .unwrap_err();
        assert!(error.contains("repeats root-mirror package"), "got: {error}");
    }

    #[test]
    fn local_rebuild_graph_filters_select_transitive_unions_and_reject_ambiguous_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "base-a", &[], &[]);
        package(root, "base-b", &[], &[]);
        let first = product(root, "first", &[]);
        let second = product(root, "second", &["first"]);
        product(root, "dormant", &[]);
        let set = authority(
            root,
            &[("base-a", "platform"), ("base-b", "platform")],
            &[
                ("first", "base-a", first.as_path()),
                ("second", "base-b", second.as_path()),
            ],
            &[],
            &[],
        );
        let mut source = fs::read_to_string(&set)
            .unwrap()
            .replace("dormant_products = []\n", "");
        source.push_str("[[dormant_products]]\nname = \"dormant\"\nreason = \"not selected\"\n");
        write(&set, &source);
        let graph = load_and_plan(root, &set, &registry(root)).unwrap();

        let complete = select_graph_dependencies(&graph, &[]).unwrap();
        assert_eq!(
            complete,
            select_graph_dependencies(&graph, &["all".to_string()]).unwrap(),
        );
        assert_eq!(
            select_graph_dependencies(&graph, &["first".to_string()])
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                PlanNodeV1::package("base-a", "wasm32"),
                PlanNodeV1::product("first"),
            ]),
        );
        assert_eq!(
            select_graph_dependencies(&graph, &["first".to_string(), "second".to_string()],)
                .unwrap(),
            complete,
        );

        for (filters, expected) in [
            (vec!["first", "first"], "repeated"),
            (vec!["all", "first"], "mixed"),
            (vec!["all", "all"], "repeated"),
            (vec!["missing"], "unknown"),
            (vec!["dormant"], "dormant"),
        ] {
            let filters = filters.into_iter().map(str::to_string).collect::<Vec<_>>();
            let error = select_graph_dependencies(&graph, &filters).unwrap_err();
            assert!(error.contains(expected), "{filters:?}: {error}");
        }
    }

    #[test]
    fn local_rebuild_graph_filters_select_bare_package_names_and_wasm64_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "base-a", &[], &[]);
        package(root, "mariadb", &["wasm32", "wasm64"], &[]);
        package(root, "wasm64-only", &["wasm64"], &[]);
        product(root, "unused", &[]);
        let set = authority(
            root,
            &[
                ("base-a", "platform"),
                ("mariadb", "user-software"),
                ("wasm64-only", "platform"),
            ],
            &[],
            &[],
            &[],
        );
        let graph = load_and_plan(root, &set, &registry(root)).unwrap();

        // `xtask bootstrap kernel`/`./run.sh build zlib`-style bare package
        // selection: a target that names a registry package directly (not a
        // declared VFS product) selects that package's wasm32 node.
        assert_eq!(
            select_graph_dependencies(&graph, &["base-a".to_string()])
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([PlanNodeV1::package("base-a", "wasm32")]),
        );

        // `./run.sh build mariadb64`-style targets: the historical "64"
        // suffix convention selects the wasm64 node of the base package.
        assert_eq!(
            select_graph_dependencies(&graph, &["mariadb64".to_string()])
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([PlanNodeV1::package("mariadb", "wasm64")]),
        );
        assert_eq!(
            select_graph_dependencies(&graph, &["mariadb".to_string()])
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([PlanNodeV1::package("mariadb", "wasm32")]),
        );

        let error = select_graph_dependencies(&graph, &["not-a-thing".to_string()]).unwrap_err();
        assert!(error.contains("unknown"), "{error}");

        // A package that exists ONLY at wasm64 (no wasm32 counterpart, and
        // its name has no "64" suffix to strip) must still resolve by its
        // plain name via the final wasm64-literal fallback, not just via the
        // "64" suffix convention covered above.
        assert_eq!(
            select_graph_dependencies(&graph, &["wasm64-only".to_string()])
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([PlanNodeV1::package("wasm64-only", "wasm64")]),
        );
    }

    #[test]
    fn package_target_needs_sysroot64_matches_the_64_suffix_convention() {
        assert!(package_target_needs_sysroot64("mariadb64"));
        assert!(package_target_needs_sysroot64("sqlite64"));
        assert!(!package_target_needs_sysroot64("mariadb"));
        assert!(!package_target_needs_sysroot64("zlib"));
        assert!(!package_target_needs_sysroot64("kernel"));
    }

    #[test]
    fn local_rebuild_graph_authority_binds_exact_inputs_and_private_edges() {
        use sha2::{Digest, Sha256};

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "app", &[], &[("source-input", "1.0.0")]);
        source_package(root, "source-input");
        let manifest = product(root, "browser-app", &[]);
        let set = authority(
            root,
            &[("app", "browser-product")],
            &[("browser-app", "app", manifest.as_path())],
            &[],
            &["source-input"],
        );

        let graph = load_and_plan(root, &set, &registry(root)).unwrap();
        let authority_bytes = graph_authority_bytes(&graph.authority).unwrap();
        assert_eq!(
            graph.authority.supported_set_sha256,
            format!("{:x}", Sha256::digest(fs::read(&set).unwrap())),
        );
        assert_eq!(
            graph.authority.nodes,
            graph.dependencies.keys().cloned().collect::<Vec<_>>()
        );
        assert_eq!(
            graph.authority.direct_edges,
            vec![
                GraphDirectEdgeV1 {
                    dependency: PlanNodeV1::package("app", "wasm32"),
                    dependent: PlanNodeV1::product("browser-app"),
                },
                GraphDirectEdgeV1 {
                    dependency: PlanNodeV1::package("source-input", "wasm32"),
                    dependent: PlanNodeV1::package("app", "wasm32"),
                },
            ],
        );
        assert_eq!(graph.authority.registry_package_toml.len(), 2);
        assert_eq!(graph.authority.product_bindings.len(), 1);
        assert_eq!(graph.product_execution.len(), 1);
        assert!(!String::from_utf8_lossy(&authority_bytes).contains(&root.display().to_string()));

        let mut hash = Sha256::new();
        hash.update(b"kandelo-local-build-graph-authority-v1\0");
        hash.update(&authority_bytes);
        assert_eq!(graph.authority_sha256, format!("{:x}", hash.finalize()));

        let before = graph.authority_sha256;
        let package_path = root.join("packages/registry/app/package.toml");
        let mut package_bytes = fs::read(&package_path).unwrap();
        package_bytes.extend_from_slice(b"\n");
        fs::write(&package_path, package_bytes).unwrap();
        let changed = load_and_plan(root, &set, &registry(root)).unwrap();
        assert_ne!(changed.authority_sha256, before);
    }

    #[test]
    fn local_rebuild_args_job_precedence_and_invalid_values_are_exact() {
        use std::num::NonZeroUsize;

        assert_eq!(
            select_job_count(
                Some("2"),
                Some("not-a-number"),
                Some(NonZeroUsize::new(8).unwrap()),
            )
            .unwrap(),
            2,
        );
        assert_eq!(
            select_job_count(None, Some("3"), Some(NonZeroUsize::new(8).unwrap())).unwrap(),
            3,
        );
        assert_eq!(
            select_job_count(None, None, Some(NonZeroUsize::new(4).unwrap())).unwrap(),
            4,
        );
        assert_eq!(select_job_count(None, None, None).unwrap(), 1);
        for value in [
            "",
            "0",
            "-1",
            "+1",
            " 1",
            "1 ",
            "no",
            "184467440737095516160",
        ] {
            let error = select_job_count(None, Some(value), None).unwrap_err();
            assert!(
                error.contains("WASM_POSIX_LOCAL_BUILD_JOBS"),
                "{value:?}: {error}"
            );
        }
    }

    #[test]
    fn bootstrap_step_order_builds_toolchain_before_engine_and_host_after() {
        let steps = bootstrap_step_plan();
        let names: Vec<&str> = steps.iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec![
                "fork-instrument-tool",
                "sysroot",
                "sysroot64",
                "sdk",
                "engine",
                "rootfs",
                "host-dist",
            ],
            "fork-instrument must precede the engine (msmtpd needs it); sysroot/ \
             sysroot64/sdk must precede the engine (every package build script reads \
             the ambient musl sysroot and wasm{{32,64}}posix-cc directly, which the \
             engine's own dependency graph does not model as an edge) and sdk must \
             follow sysroot (sdk only checks sysroot's toolchain wrappers resolve); \
             rootfs must follow the engine (build-rootfs.sh consumes the packages the \
             engine just built) and precede host-dist (host build should see a fresh \
             rootfs image); host-dist must follow the engine (needs the regenerated \
             program index)"
        );
    }

    #[test]
    fn bootstrap_selection_from_args_accepts_omitted_all_and_single_targets() {
        let (selection, rest) = bootstrap_selection_from_args(&[]).unwrap();
        assert_eq!(selection, Selection::All);
        assert!(rest.is_empty());

        let (selection, rest) =
            bootstrap_selection_from_args(&["all".to_string()]).unwrap();
        assert_eq!(selection, Selection::All);
        assert!(rest.is_empty());

        let (selection, rest) = bootstrap_selection_from_args(&[
            "all".to_string(),
            "--jobs".to_string(),
            "2".to_string(),
        ])
        .unwrap();
        assert_eq!(selection, Selection::All);
        assert_eq!(rest, vec!["--jobs".to_string(), "2".to_string()]);

        let (selection, rest) = bootstrap_selection_from_args(&[
            "kernel".to_string(),
            "--rebuild".to_string(),
        ])
        .unwrap();
        assert_eq!(selection, Selection::Package("kernel".to_string()));
        assert_eq!(rest, vec!["--rebuild".to_string()]);
    }

    #[test]
    fn bootstrap_single_target_maps_to_engine_or_host_step() {
        assert_eq!(
            bootstrap_target_to_selection("kernel"),
            Selection::Package("kernel".to_string())
        );
        assert_eq!(
            bootstrap_target_to_selection("zlib"),
            Selection::Package("zlib".to_string())
        );
        assert_eq!(
            bootstrap_target_to_selection("host"),
            Selection::HostStep("host-dist")
        );
        assert_eq!(
            bootstrap_target_to_selection("fork-instrument"),
            Selection::HostStep("fork-instrument-tool")
        );
        assert_eq!(
            bootstrap_target_to_selection("rootfs"),
            Selection::HostStep("rootfs")
        );
        assert_eq!(
            bootstrap_target_to_selection("sysroot"),
            Selection::HostStep("sysroot")
        );
        assert_eq!(
            bootstrap_target_to_selection("sysroot64"),
            Selection::HostStep("sysroot64")
        );
        assert_eq!(
            bootstrap_target_to_selection("sdk"),
            Selection::HostStep("sdk")
        );
    }

    fn uleb128(mut value: u32, out: &mut Vec<u8>) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    fn sleb128_i32(mut value: i64, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            let sign_bit = byte & 0x40 != 0;
            if (value == 0 && !sign_bit) || (value == -1 && sign_bit) {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
    }

    fn wasm_section(id: u8, payload: &[u8], out: &mut Vec<u8>) {
        out.push(id);
        uleb128(payload.len() as u32, out);
        out.extend_from_slice(payload);
    }

    /// Build the smallest wasm module `wasm_declared_abi_version` accepts: one
    /// `() -> i32` function, exported as `__abi_version`, whose body is
    /// exactly `i32.const <abi> end` — the plain constant shape
    /// `_wasm_extract_constant_i32_body` in `scripts/wasm-artifact-guards.sh`
    /// also recognizes.
    fn kernel_wasm_with_abi(abi: u32) -> Vec<u8> {
        let mut module = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

        // Type section: one type, () -> i32.
        wasm_section(1, &[0x01, 0x60, 0x00, 0x01, 0x7f], &mut module);
        // Function section: one function using type 0.
        wasm_section(3, &[0x01, 0x00], &mut module);
        // Export section: "__abi_version" -> func 0.
        let name = b"__abi_version";
        let mut exports = Vec::new();
        exports.push(0x01);
        uleb128(name.len() as u32, &mut exports);
        exports.extend_from_slice(name);
        exports.push(0x00); // func kind
        exports.push(0x00); // func index
        wasm_section(7, &exports, &mut module);
        // Code section: one body, `i32.const <abi> end`.
        let mut body = vec![0x00]; // no locals
        body.push(0x41); // i32.const
        sleb128_i32(abi as i64, &mut body);
        body.push(0x0b); // end
        let mut code = Vec::new();
        code.push(0x01);
        uleb128(body.len() as u32, &mut code);
        code.extend_from_slice(&body);
        wasm_section(10, &code, &mut module);

        module
    }

    fn temp_repo_with_kernel(kernel_abi: u32) -> tempfile::TempDir {
        let temp = tempfile::TempDir::new().unwrap();
        let kernel_path = temp
            .path()
            .join("local-binaries/source-only-v1/kernel.wasm");
        fs::create_dir_all(kernel_path.parent().unwrap()).unwrap();
        fs::write(&kernel_path, kernel_wasm_with_abi(kernel_abi)).unwrap();
        temp
    }

    #[test]
    fn verify_fresh_flags_a_stale_abi_kernel() {
        let repo = temp_repo_with_kernel(wasm_posix_shared::ABI_VERSION - 1);
        let err = verify_fresh_report(repo.path()).unwrap_err();
        assert!(
            err.contains("kernel.wasm") && err.contains("ABI"),
            "must name the stale kernel and why: {err}"
        );
    }

    /// A current-ABI kernel that carries no build-key stamp is no longer
    /// accepted as fresh: passing the ABI check is necessary but not
    /// sufficient, since a same-ABI internal change moves the build key. The
    /// synthetic fixture here has no stamp, so it must be flagged. (A kernel
    /// carrying the *correct* stamp verifying fresh through the real build
    /// engine is proven by `verify_fresh_passes_for_a_real_materialized_kernel_stamp`
    /// in `build_deps`, which needs that module's materialize fixtures.)
    #[test]
    fn verify_fresh_flags_a_current_abi_kernel_with_no_build_key_stamp() {
        let repo = temp_repo_with_kernel(wasm_posix_shared::ABI_VERSION);
        let err = verify_fresh_report(repo.path()).unwrap_err();
        assert!(
            err.contains("no build key stamp"),
            "an unstamped current-ABI kernel must fail the build-key check: {err}"
        );
    }

    #[test]
    fn verify_fresh_ok_when_no_local_kernel_build_exists_yet() {
        let temp = tempfile::TempDir::new().unwrap();
        assert!(
            verify_fresh_report(temp.path()).is_ok(),
            "an unbuilt tree has no stale kernel to flag"
        );
    }

    /// Build a wasm module exporting `__abi_version` (func 0) whose body is
    /// exactly the given bytes (locals-count prefix included), instead of the
    /// recognized `i32.const <N> [return] end` constant shape.
    fn wasm_module_with_abi_version_body(body: &[u8]) -> Vec<u8> {
        let mut module = vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
        wasm_section(1, &[0x01, 0x60, 0x00, 0x01, 0x7f], &mut module);
        wasm_section(3, &[0x01, 0x00], &mut module);
        let name = b"__abi_version";
        let mut exports = Vec::new();
        exports.push(0x01);
        uleb128(name.len() as u32, &mut exports);
        exports.extend_from_slice(name);
        exports.push(0x00); // func kind
        exports.push(0x00); // func index
        wasm_section(7, &exports, &mut module);
        let mut code = Vec::new();
        code.push(0x01);
        uleb128(body.len() as u32, &mut code);
        code.extend_from_slice(body);
        wasm_section(10, &code, &mut module);
        module
    }

    fn write_kernel_wasm(temp: &tempfile::TempDir, bytes: &[u8]) {
        let kernel_path = temp
            .path()
            .join("local-binaries/source-only-v1/kernel.wasm");
        fs::create_dir_all(kernel_path.parent().unwrap()).unwrap();
        fs::write(&kernel_path, bytes).unwrap();
    }

    #[test]
    fn verify_fresh_reports_a_malformed_abi_version_export_body() {
        let temp = tempfile::TempDir::new().unwrap();
        // `nop end` (no locals): not the recognized `i32.const <N> [return]
        // end` constant shape `wasm_declared_abi_version` requires.
        write_kernel_wasm(
            &temp,
            &wasm_module_with_abi_version_body(&[0x00, 0x01, 0x0b]),
        );

        let err = verify_fresh_report(temp.path()).unwrap_err();
        assert!(
            err.contains("i32.const"),
            "must report the unrecognized constant shape: {err}"
        );
    }

    #[test]
    fn verify_fresh_reports_a_kernel_with_no_abi_version_export() {
        let temp = tempfile::TempDir::new().unwrap();
        // The bare 8-byte wasm header: a valid, empty module with no export
        // section at all, so `wasm_declared_abi_version` finds no
        // `__abi_version` export and returns `Ok(None)`.
        write_kernel_wasm(&temp, &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

        let err = verify_fresh_report(temp.path()).unwrap_err();
        assert!(
            err.contains("kernel.wasm has no __abi_version export"),
            "must name the missing export: {err}"
        );
    }

    // -- snapshot_drift_check / abi_sources_changed_since_snapshot (B3) --
    //
    // `check-abi-version.sh check` itself is deliberately NOT exercised
    // here: it requires a real git checkout (`git rev-parse
    // --show-toplevel`) and builds the kernel wasm via `cargo build -p
    // kandelo`, so it cannot run against these synthetic temp repos
    // without failing for the wrong reason (no git root / unbuildable
    // kernel, not snapshot drift). These tests instead cover the two
    // pieces that ARE unit-testable in isolation:
    //   - the mtime gate (`abi_sources_changed_since_snapshot` /
    //     `newest_mtime_under`), including that `snapshot_drift_check`
    //     honors a false gate without shelling out at all; and
    //   - the exit-code-to-error mapping (`run_check_abi_version_check`),
    //     exercised against a stub script instead of the real one.
    // A genuinely-drifted `abi/snapshot.json` actually failing
    // `verify-fresh` end to end is validated in Task 9, against the real
    // repo.

    fn set_mtime(path: &Path, when: std::time::SystemTime) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(when).unwrap();
    }

    #[test]
    fn snapshot_drift_check_skips_the_script_when_the_gate_is_false() {
        let repo = tempfile::TempDir::new().unwrap();
        let now = std::time::SystemTime::now();
        let hour_ago = now - std::time::Duration::from_secs(3600);

        let shared_src = repo.path().join("crates/shared/src/lib.rs");
        fs::create_dir_all(shared_src.parent().unwrap()).unwrap();
        fs::write(&shared_src, "// shared").unwrap();
        set_mtime(&shared_src, hour_ago);

        let kernel_src = repo.path().join("crates/kernel/src/lib.rs");
        fs::create_dir_all(kernel_src.parent().unwrap()).unwrap();
        fs::write(&kernel_src, "// kernel").unwrap();
        set_mtime(&kernel_src, hour_ago);

        // Newer than both sources, but deliberately not valid JSON: if the
        // gate were open this would reach `check-abi-version.sh` (which
        // does not exist under this synthetic repo) and fail to launch.
        let snapshot = repo.path().join("abi/snapshot.json");
        fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
        fs::write(&snapshot, "not-json").unwrap();
        set_mtime(&snapshot, now);

        snapshot_drift_check(repo.path(), /* force= */ false)
            .expect("gate must skip the check when no ABI source is newer than the snapshot");
    }

    #[test]
    fn abi_sources_changed_since_snapshot_is_true_when_the_snapshot_is_missing() {
        let repo = tempfile::TempDir::new().unwrap();
        assert!(
            abi_sources_changed_since_snapshot(repo.path()).unwrap(),
            "a missing snapshot must resolve to the conservative 'run the check' outcome"
        );
    }

    #[test]
    fn abi_sources_changed_since_snapshot_is_false_when_source_dirs_are_absent() {
        let repo = tempfile::TempDir::new().unwrap();
        let snapshot = repo.path().join("abi/snapshot.json");
        fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
        fs::write(&snapshot, "{}").unwrap();
        // No crates/shared or crates/kernel under this repo at all.
        assert!(
            !abi_sources_changed_since_snapshot(repo.path()).unwrap(),
            "an absent source directory contributes no files, not ambiguity"
        );
    }

    #[test]
    fn abi_sources_changed_since_snapshot_is_true_when_a_source_is_newer_than_the_snapshot() {
        let repo = tempfile::TempDir::new().unwrap();
        let now = std::time::SystemTime::now();
        let hour_ago = now - std::time::Duration::from_secs(3600);

        let snapshot = repo.path().join("abi/snapshot.json");
        fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
        fs::write(&snapshot, "{}").unwrap();
        set_mtime(&snapshot, hour_ago);

        let shared_src = repo.path().join("crates/shared/src/lib.rs");
        fs::create_dir_all(shared_src.parent().unwrap()).unwrap();
        fs::write(&shared_src, "// shared, edited after the snapshot").unwrap();
        set_mtime(&shared_src, now);

        assert!(
            abi_sources_changed_since_snapshot(repo.path()).unwrap(),
            "a source newer than the snapshot must open the gate"
        );
    }

    /// A directory-walk error inside an EXISTING source directory (as
    /// opposed to the directory itself being absent, covered above) is
    /// ambiguity unrelated to ABI drift, not proof of "nothing changed."
    /// The gate must resolve this to `true` (run the authoritative check)
    /// rather than propagating the error and failing the whole pre-test
    /// gate on something that has nothing to do with the ABI snapshot.
    /// Constructed with a permission-restricted subdirectory rather than a
    /// stubbed seam: `newest_mtime_under` walks the real filesystem with no
    /// injection point, and an unreadable directory is a robust, portable
    /// way to make `fs::read_dir` fail on Unix without relying on a
    /// dangling-symlink `metadata()` call, which does NOT error (`DirEntry
    /// ::metadata` on Unix is `lstat`-equivalent and succeeds even for a
    /// dangling symlink).
    #[test]
    #[cfg(unix)]
    fn abi_sources_changed_since_snapshot_is_true_when_an_existing_source_dir_has_an_unreadable_entry()
     {
        use std::os::unix::fs::PermissionsExt;

        let repo = tempfile::TempDir::new().unwrap();
        let snapshot = repo.path().join("abi/snapshot.json");
        fs::create_dir_all(snapshot.parent().unwrap()).unwrap();
        fs::write(&snapshot, "{}").unwrap();

        // `crates/shared` DOES exist here (unlike the "absent dir" test
        // above), but a subdirectory inside it cannot be listed.
        let restricted = repo.path().join("crates/shared/restricted");
        fs::create_dir_all(&restricted).unwrap();
        let original_permissions = fs::metadata(&restricted).unwrap().permissions();
        fs::set_permissions(&restricted, fs::Permissions::from_mode(0o000)).unwrap();

        let result = abi_sources_changed_since_snapshot(repo.path());

        // Restore permissions unconditionally (before asserting) so a
        // failing assertion never leaves an unreadable directory behind
        // for the `TempDir` to fail to clean up.
        fs::set_permissions(&restricted, original_permissions).unwrap();

        assert!(
            result.unwrap(),
            "an unreadable entry inside an EXISTING source dir must open the \
             gate, not fail closed or silently report no change"
        );
    }

    #[test]
    fn run_check_abi_version_check_maps_a_nonzero_exit_to_a_loud_error() {
        let repo = tempfile::TempDir::new().unwrap();
        fs::write(repo.path().join("fake-check.sh"), "#!/bin/bash\nexit 1\n").unwrap();

        let err = run_check_abi_version_check(repo.path(), "fake-check.sh").unwrap_err();
        assert!(
            err.contains("snapshot") && err.contains("check-abi-version.sh update"),
            "error must name the snapshot and the update command: {err}"
        );
        // The script's own failure can be a provisioning problem (e.g. "sysroot
        // not found") rather than actual snapshot drift, since the real script
        // builds the kernel before comparing. The mapped error must not assert
        // drift as fact -- it must allow for "the check could not run" too.
        assert!(
            err.contains("could not run"),
            "error must not assert drift as the only explanation for a non-zero exit: {err}"
        );
    }

    #[test]
    fn run_check_abi_version_check_is_ok_when_the_script_exits_zero() {
        let repo = tempfile::TempDir::new().unwrap();
        fs::write(repo.path().join("fake-check.sh"), "#!/bin/bash\nexit 0\n").unwrap();

        run_check_abi_version_check(repo.path(), "fake-check.sh")
            .expect("a zero exit must not be reported as drift");
    }

    #[test]
    fn local_rebuild_args_parse_both_spellings_and_reject_duplicate_or_cross_kind_flags() {
        use std::num::NonZeroUsize;

        let parsed = parse_local_build_args_with_jobs(
            &[
                "run".into(),
                "--set=packages/sets/local-supported.toml".into(),
                "--source-cache-root".into(),
                "/tmp/source-cache".into(),
                "--output-root=/tmp/output".into(),
                "--product=browser-main-shell".into(),
                "--jobs".into(),
                "2".into(),
                "--rebuild".into(),
            ],
            Some("broken"),
            Some(NonZeroUsize::new(8).unwrap()),
        )
        .unwrap();
        assert_eq!(
            parsed,
            LocalBuildCommandV1::Run(LocalBuildRunArgsV1 {
                set: PathBuf::from("packages/sets/local-supported.toml"),
                source_cache_root: PathBuf::from("/tmp/source-cache"),
                output_root: PathBuf::from("/tmp/output"),
                products: vec!["browser-main-shell".to_string()],
                jobs: 2,
                rebuild: true,
                verify_cache: false,
            })
        );

        let digest = "1".repeat(64);
        let child = parse_local_build_args_with_jobs(
            &[
                "run-node".into(),
                "--repo-root=/tmp/repo".into(),
                "--set".into(),
                "/tmp/repo/packages/sets/local-supported.toml".into(),
                format!("--graph-authority-sha256={digest}"),
                "--source-cache-root=/tmp/cache".into(),
                "--compiled-cache-root=/tmp/cache/source-only-v1/compiled".into(),
                "--output-root=/tmp/output".into(),
                "--node-kind=package".into(),
                "--package=app".into(),
                "--target-arch=wasm32".into(),
                "--result-json=/tmp/results/app.json".into(),
            ],
            None,
            None,
        )
        .unwrap();
        assert!(matches!(
            child,
            LocalBuildCommandV1::RunNode(LocalBuildRunNodeArgsV1 {
                node: PlanNodeV1::Package { ref name, ref target_arch },
                ..
            }) if name == "app" && target_arch == "wasm32"
        ));

        for args in [
            vec![
                "run",
                "--set=a",
                "--set=b",
                "--source-cache-root=/tmp/cache",
                "--output-root=/tmp/out",
            ],
            vec![
                "run",
                "--set=a",
                "--source-cache-root=/tmp/cache",
                "--output-root=/tmp/out",
                "--product=all",
                "--product=browser-main-shell",
            ],
            vec![
                "run-node",
                "--repo-root=/tmp/repo",
                "--set=/tmp/set",
                "--graph-authority-sha256=1111111111111111111111111111111111111111111111111111111111111111",
                "--source-cache-root=/tmp/cache",
                "--compiled-cache-root=/tmp/cache/source-only-v1/compiled",
                "--output-root=/tmp/out",
                "--node-kind=product",
                "--product=app",
                "--package=wrong-kind",
                "--result-json=/tmp/result",
            ],
        ] {
            let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
            assert!(parse_local_build_args_with_jobs(&args, None, None).is_err());
        }
    }

    #[test]
    fn local_rebuild_protocol_run_node_admission_failure_writes_exact_failed_result_without_node_work()
     {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("repo");
        fs::create_dir(&root).unwrap();
        package(&root, "app", &[], &[]);
        product(&root, "catalog-only", &[]);
        let set = authority(&root, &[("app", "user-software")], &[], &[], &[]);
        let source_cache_root = temp.path().join("source-cache");
        let compiled_cache_root = source_cache_root.join("source-only-v1/compiled");
        let output_root = temp.path().join("output");
        let result_root = temp.path().join("results");
        fs::create_dir_all(&compiled_cache_root).unwrap();
        fs::create_dir(&output_root).unwrap();
        fs::create_dir(&result_root).unwrap();
        let result_json = fs::canonicalize(&result_root).unwrap().join("app.json");
        let node = PlanNodeV1::package("app", "wasm32");

        let error = run_node(LocalBuildRunNodeArgsV1 {
            repo_root: fs::canonicalize(&root).unwrap(),
            set: fs::canonicalize(&set).unwrap(),
            graph_authority_sha256: "0".repeat(64),
            source_cache_root: fs::canonicalize(&source_cache_root).unwrap(),
            compiled_cache_root: fs::canonicalize(&compiled_cache_root).unwrap(),
            output_root: fs::canonicalize(&output_root).unwrap(),
            node: node.clone(),
            result_json: result_json.clone(),
            rebuild: false,
            verify_cache: false,
        })
        .unwrap_err();

        assert!(error.contains("graph authority"), "{error}");
        let result: NodeExecutionResultV1 =
            serde_json::from_slice(&fs::read(&result_json).unwrap()).unwrap();
        assert_eq!(
            result,
            NodeExecutionResultV1 {
                schema: 1,
                policy: LOCAL_SUPPORTED_POLICY.to_string(),
                result: NodeRunResultV1::Failed {
                    node,
                    exit_code: Some(1),
                },
                package_receipt: None,
            }
        );
        assert!(fs::read_dir(&compiled_cache_root).unwrap().next().is_none());
        assert!(fs::read_dir(&output_root).unwrap().next().is_none());
    }

    #[test]
    fn local_rebuild_render_uses_exact_palette_and_machine_json_has_no_ansi() {
        for (token, plain, color) in [
            (LifecycleTokenV1::Ready, "READY", "\u{1b}[34mREADY\u{1b}[0m"),
            (
                LifecycleTokenV1::Queued,
                "QUEUED",
                "\u{1b}[34mQUEUED\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Running,
                "RUNNING",
                "\u{1b}[36mRUNNING\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Continuing,
                "CONTINUING",
                "\u{1b}[36mCONTINUING\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Cached,
                "CACHED",
                "\u{1b}[32mCACHED\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Reused,
                "REUSED",
                "\u{1b}[32mREUSED\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Succeeded,
                "SUCCEEDED",
                "\u{1b}[32mSUCCEEDED\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Blocked,
                "BLOCKED",
                "\u{1b}[33mBLOCKED\u{1b}[0m",
            ),
            (
                LifecycleTokenV1::Failed,
                "FAILED",
                "\u{1b}[31mFAILED\u{1b}[0m",
            ),
        ] {
            assert_eq!(render_lifecycle_token(token, false), plain);
            assert_eq!(render_lifecycle_token(token, true), color);
        }
        assert!(!ansi_enabled(false, false));
        assert!(!ansi_enabled(true, true));
        assert!(ansi_enabled(true, false));
        assert_eq!(
            render_failure_banner(false),
            "LOCAL BUILD FAILED — continuing independent work"
        );
        assert_eq!(
            render_failure_banner(true),
            "\u{1b}[31mLOCAL BUILD FAILED — continuing independent work\u{1b}[0m"
        );
        assert_eq!(
            render_projection_failure_banner(false),
            "LOCAL BUILD FAILED — source-only program authority was not published"
        );
        assert_eq!(
            render_projection_failure_banner(true),
            "\u{1b}[31mLOCAL BUILD FAILED — source-only program authority was not published\u{1b}[0m"
        );

        let result = LocalBuildRunResultV1 {
            schema: 1,
            policy: LOCAL_SUPPORTED_POLICY.to_string(),
            outcome: AggregateOutcomeV1::Failed,
            nodes: vec![NodeRunResultV1::Blocked {
                node: PlanNodeV1::product("browser-app"),
                failed_ancestors: vec![PlanNodeV1::package("app", "wasm32")],
            }],
        };
        let bytes = canonical_machine_json(&result).unwrap();
        assert_eq!(
            bytes,
            b"{\"nodes\":[{\"failed_ancestors\":[{\"kind\":\"package\",\"name\":\"app\",\"target_arch\":\"wasm32\"}],\"node\":{\"id\":\"browser-app\",\"kind\":\"product\"},\"state\":\"blocked\"}],\"outcome\":\"failed\",\"policy\":\"source-only-v1\",\"schema\":1}\n"
        );
        assert!(!bytes.contains(&0x1b));
        let decoded: LocalBuildRunResultV1 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded, result);

        let mut hostile = serde_json::to_value(&result).unwrap();
        hostile["nodes"][0]["extra"] = serde_json::json!(true);
        assert!(serde_json::from_value::<LocalBuildRunResultV1>(hostile).is_err());
    }

    #[test]
    fn local_rebuild_protocol_supervisor_projection_has_exact_selected_v2_nodes() {
        use crate::build_deps::{
            MaterializedProgramMemberV1, PackageNodeReceiptV1, ProgramPackageIdentity,
            ProgramDependencyIdentity, ProgramPackageIndex, ProgramPackageProjection,
            ProgramPackageProjectionMember,
        };

        let manifest_sha256 = "11".repeat(32);
        let cache_key_sha256 = "22".repeat(32);
        let contextual_wasm64_key = "33".repeat(32);
        let cache_receipt_sha256 = "44".repeat(32);
        let member_sha256 = "55".repeat(32);
        let projection = ProgramPackageIndex {
            format: "kandelo-program-packages-v2",
            identities: BTreeMap::from([
                (
                    "app".to_string(),
                    ProgramPackageIdentity {
                        manifest_sha256: manifest_sha256.clone(),
                        cache_keys: BTreeMap::from([
                            ("wasm32".to_string(), cache_key_sha256.clone()),
                            ("wasm64".to_string(), contextual_wasm64_key),
                        ]),
                    },
                ),
                (
                    "dependency-only-identity".to_string(),
                    ProgramPackageIdentity {
                        manifest_sha256: "bb".repeat(32),
                        cache_keys: BTreeMap::from([
                            ("wasm32".to_string(), "cc".repeat(32)),
                            ("wasm64".to_string(), "dd".repeat(32)),
                        ]),
                    },
                ),
            ]),
            packages: BTreeMap::from([(
                "app".to_string(),
                ProgramPackageProjection {
                    manifest_sha256: manifest_sha256.clone(),
                    arches: vec!["wasm32".to_string()],
                    cache_keys: BTreeMap::from([(
                        "wasm32".to_string(),
                        cache_key_sha256.clone(),
                    )]),
                    dependency_closures: BTreeMap::from([(
                        "wasm32".to_string(),
                        vec![ProgramDependencyIdentity {
                            package_name: "dependency-only-identity".to_string(),
                            manifest_sha256: "bb".repeat(32),
                            cache_key: "cc".repeat(32),
                        }],
                    )]),
                    members: vec![ProgramPackageProjectionMember {
                        kind: "output",
                        source_artifact: "app.wasm".to_string(),
                        mirror_path: "app.wasm".to_string(),
                        output_name: Some("app".to_string()),
                        fork_instrumentation: Some("auto".to_string()),
                        guest_path: None,
                        mode: None,
                    }],
                },
            )]),
        };
        let node = PlanNodeV1::package("app", "wasm32");
        let kernel_node = PlanNodeV1::package("kernel", "wasm32");
        let receipt = PackageNodeReceiptV1 {
            manifest_sha256: manifest_sha256.clone(),
            cache_key_sha256: cache_key_sha256.clone(),
            cache_receipt_sha256: cache_receipt_sha256.clone(),
            materialized_members: vec![MaterializedProgramMemberV1 {
                source_artifact: "app.wasm".to_string(),
                mirror_path: "programs/wasm32/app.wasm".to_string(),
                mode: 0o755,
                size: 3,
                sha256: member_sha256.clone(),
            }],
        };
        let kernel_receipt = PackageNodeReceiptV1 {
            manifest_sha256: "77".repeat(32),
            cache_key_sha256: "88".repeat(32),
            cache_receipt_sha256: "99".repeat(32),
            materialized_members: vec![MaterializedProgramMemberV1 {
                source_artifact: "kandelo-kernel.wasm".to_string(),
                mirror_path: "kernel.wasm".to_string(),
                mode: 0o755,
                size: 4,
                sha256: "aa".repeat(32),
            }],
        };
        let receipts = BTreeMap::from([
            (node, receipt.clone()),
            (kernel_node.clone(), kernel_receipt.clone()),
        ]);
        let authority = source_only_program_projection_candidate(
            projection,
            &"66".repeat(32),
            &receipts,
            &BTreeSet::from([kernel_node.clone()]),
        )
        .unwrap();
        let bytes = source_only_program_projection_bytes(&authority).unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(
            parsed,
            serde_json::json!({
                "format": "kandelo-source-only-program-projection-v1",
                "projection": {
                    "format": "kandelo-program-packages-v2",
                    "identities": {
                        "app": {
                            "manifestSha256": manifest_sha256,
                            "cacheKeys": {
                                "wasm32": cache_key_sha256,
                                "wasm64": "33".repeat(32),
                            },
                        },
                        "dependency-only-identity": {
                            "manifestSha256": "bb".repeat(32),
                            "cacheKeys": {
                                "wasm32": "cc".repeat(32),
                                "wasm64": "dd".repeat(32),
                            },
                        },
                    },
                    "packages": {
                        "app": {
                            "manifestSha256": "11".repeat(32),
                            "arches": ["wasm32"],
                            "cacheKeys": { "wasm32": "22".repeat(32) },
                            "dependencyClosures": {
                                "wasm32": [{
                                    "packageName": "dependency-only-identity",
                                    "manifestSha256": "bb".repeat(32),
                                    "cacheKey": "cc".repeat(32),
                                }],
                            },
                            "members": [{
                                "kind": "output",
                                "sourceArtifact": "app.wasm",
                                "mirrorPath": "app.wasm",
                                "outputName": "app",
                                "forkInstrumentation": "auto",
                            }],
                        },
                    },
                },
                "graphAuthoritySha256": "66".repeat(32),
                "nodes": [
                    {
                        "node": {
                            "kind": "package",
                            "name": "app",
                            "targetArch": "wasm32",
                        },
                        "manifestSha256": "11".repeat(32),
                        "cacheKeySha256": "22".repeat(32),
                        "cacheReceiptSha256": cache_receipt_sha256,
                        "members": [{
                            "sourceArtifact": "app.wasm",
                            "mirrorPath": "programs/wasm32/app.wasm",
                            "mode": 493,
                            "size": 3,
                            "sha256": member_sha256,
                        }],
                    },
                    {
                        "node": {
                            "kind": "package",
                            "name": "kernel",
                            "targetArch": "wasm32",
                        },
                        "manifestSha256": "77".repeat(32),
                        "cacheKeySha256": "88".repeat(32),
                        "cacheReceiptSha256": "99".repeat(32),
                        "members": [{
                            "sourceArtifact": "kandelo-kernel.wasm",
                            "mirrorPath": "kernel.wasm",
                            "mode": 493,
                            "size": 4,
                            "sha256": "aa".repeat(32),
                        }],
                    },
                ],
            }),
        );
        assert_eq!(bytes.last(), Some(&b'\n'));
        assert!(bytes.starts_with(b"{\n  \"format\""));

        let rogue_node = PlanNodeV1::package("rogue", "wasm32");
        let error = source_only_program_projection_candidate(
            authority.projection.clone(),
            &"66".repeat(32),
            &BTreeMap::from([
                (PlanNodeV1::package("app", "wasm32"), receipt.clone()),
                (rogue_node.clone(), kernel_receipt.clone()),
            ]),
            &BTreeSet::from([rogue_node]),
        )
        .unwrap_err();
        assert!(error.contains("only kernel"), "{error}");

        let mut kernel_in_v2 = authority.projection.clone();
        let kernel_package = kernel_in_v2.packages.remove("app").unwrap();
        let kernel_identity = kernel_in_v2.identities.remove("app").unwrap();
        kernel_in_v2
            .packages
            .insert("kernel".to_string(), kernel_package);
        kernel_in_v2
            .identities
            .insert("kernel".to_string(), kernel_identity);
        let error = source_only_program_projection_candidate(
            kernel_in_v2,
            &"66".repeat(32),
            &BTreeMap::from([(kernel_node.clone(), receipt.clone())]),
            &BTreeSet::from([kernel_node.clone()]),
        )
        .unwrap_err();
        assert!(error.contains("ordinary v2 program projection"), "{error}");

        let mut multiple_root_members = kernel_receipt.clone();
        multiple_root_members
            .materialized_members
            .push(MaterializedProgramMemberV1 {
                source_artifact: "second.wasm".to_string(),
                mirror_path: "second.wasm".to_string(),
                mode: 0o755,
                size: 1,
                sha256: "ab".repeat(32),
            });
        let error = source_only_program_projection_candidate(
            authority.projection.clone(),
            &"66".repeat(32),
            &BTreeMap::from([
                (PlanNodeV1::package("app", "wasm32"), receipt.clone()),
                (kernel_node.clone(), multiple_root_members),
            ]),
            &BTreeSet::from([kernel_node.clone()]),
        )
        .unwrap_err();
        assert!(error.contains("exactly one root-level member"), "{error}");

        let mut oversized_receipt = receipt.clone();
        oversized_receipt.materialized_members[0].size =
            SOURCE_ONLY_PROGRAM_MEMBER_LIMIT + 1;
        let error = source_only_program_projection_candidate(
            authority.projection.clone(),
            &"66".repeat(32),
            &BTreeMap::from([(
                PlanNodeV1::package("app", "wasm32"),
                oversized_receipt,
            )]),
            &BTreeSet::new(),
        )
        .unwrap_err();
        assert!(error.contains("512 MiB member limit"), "{error}");

        let mut oversized_kernel_receipt = kernel_receipt.clone();
        oversized_kernel_receipt.materialized_members[0].size =
            SOURCE_ONLY_PROGRAM_MEMBER_LIMIT + 1;
        let error = source_only_program_projection_candidate(
            authority.projection.clone(),
            &"66".repeat(32),
            &BTreeMap::from([
                (PlanNodeV1::package("app", "wasm32"), receipt.clone()),
                (kernel_node.clone(), oversized_kernel_receipt),
            ]),
            &BTreeSet::from([kernel_node.clone()]),
        )
        .unwrap_err();
        assert!(error.contains("512 MiB member limit"), "{error}");

        let mut extra_identity_projection = authority.projection.clone();
        extra_identity_projection.identities.insert(
            "unreferenced".to_string(),
            ProgramPackageIdentity {
                manifest_sha256: "ee".repeat(32),
                cache_keys: BTreeMap::from([
                    ("wasm32".to_string(), "ef".repeat(32)),
                    ("wasm64".to_string(), "f0".repeat(32)),
                ]),
            },
        );
        let error = source_only_program_projection_candidate(
            extra_identity_projection,
            &"66".repeat(32),
            &receipts,
            &BTreeSet::from([kernel_node]),
        )
        .unwrap_err();
        assert!(error.contains("exact package/dependency identity set"), "{error}");

        let mut wrong_receipt = receipt;
        wrong_receipt.cache_key_sha256 = "77".repeat(32);
        let error = source_only_program_projection_candidate(
            authority.projection,
            &"66".repeat(32),
            &BTreeMap::from([(PlanNodeV1::package("app", "wasm32"), wrong_receipt)]),
            &BTreeSet::new(),
        )
        .unwrap_err();
        assert!(error.contains("cache key"), "{error}");
    }

    #[test]
    fn local_rebuild_protocol_product_placeholders_do_not_suppress_package_authority() {
        let package = PlanNodeV1::package("app", "wasm32");
        let product = PlanNodeV1::product("browser-app");
        let selected = BTreeMap::from([
            (package.clone(), BTreeSet::new()),
            (product.clone(), BTreeSet::from([package.clone()])),
        ]);
        let package_success_product_failure = vec![
            NodeRunResultV1::Succeeded {
                node: package.clone(),
                disposition: SuccessDispositionV1::Cached,
            },
            NodeRunResultV1::Failed {
                node: product,
                exit_code: Some(1),
            },
        ];
        assert!(package_projection_is_eligible(
            &selected,
            &package_success_product_failure,
        ));

        let package_failure = vec![NodeRunResultV1::Failed {
            node: package,
            exit_code: Some(1),
        }];
        assert!(!package_projection_is_eligible(
            &selected,
            &package_failure,
        ));
    }

    #[test]
    fn strict_authority_rejects_schema_policy_names_duplicates_and_unknown_fields() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("set.toml");
        for (source, expected) in [
            (
                "schema = 2\npolicy = \"source-only-v1\"\npackages=[]\nproducts=[]\nexclusions=[]\ndependency_only=[]\nregistry_non_roots=[]\ndormant_products=[]\n",
                "schema 1",
            ),
            (
                "schema = 1\npolicy = \"binary-ok\"\npackages=[]\nproducts=[]\nexclusions=[]\ndependency_only=[]\nregistry_non_roots=[]\ndormant_products=[]\n",
                "source-only-v1",
            ),
            (
                "schema = 1\npolicy = \"source-only-v1\"\npackages=[]\nproducts=[]\nexclusions=[]\ndependency_only=[]\nregistry_non_roots=[]\ndormant_products=[]\nextra=true\n",
                "unknown field",
            ),
            (
                "schema = 1\npolicy = \"source-only-v1\"\nproducts=[]\nexclusions=[]\ndependency_only=[]\nregistry_non_roots=[]\ndormant_products=[]\n[[packages]]\nname=\"Bad\"\nclass=\"platform\"\n",
                "not normalized",
            ),
            (
                "schema = 1\npolicy = \"source-only-v1\"\nproducts=[]\nexclusions=[]\ndependency_only=[]\nregistry_non_roots=[]\ndormant_products=[]\n[[packages]]\nname=\"same\"\nclass=\"platform\"\n[[packages]]\nname=\"same\"\nclass=\"platform\"\n",
                "duplicate dispositions",
            ),
        ] {
            write(&path, source);
            assert!(parse_supported_set(&path).unwrap_err().contains(expected));
        }
    }

    #[test]
    fn plans_arch_fallback_and_products_after_mapped_and_composed_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "base", &[], &[]);
        package(root, "dual", &["wasm32", "wasm64"], &[("base", "1.0.0")]);
        let base_product = product(root, "base-product", &[]);
        let app_product = product(root, "app-product", &["base-product"]);
        let set = authority(
            root,
            &[("base", "platform"), ("dual", "browser-product")],
            &[
                ("base-product", "base", base_product.as_path()),
                ("app-product", "dual", app_product.as_path()),
            ],
            &[],
            &[],
        );
        let plan = load_and_plan(root, &set, &registry(root)).unwrap();
        assert_eq!(
            plan.levels,
            vec![
                vec![PlanNodeV1::package("base", "wasm32")],
                vec![
                    PlanNodeV1::package("dual", "wasm32"),
                    PlanNodeV1::package("dual", "wasm64"),
                    PlanNodeV1::product("base-product"),
                ],
                vec![PlanNodeV1::product("app-product")],
            ],
        );
    }

    #[test]
    fn rejects_excluded_closure_unclassified_roots_cycles_and_missing_hooks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "selected", &[], &[("forbidden", "1.0.0")]);
        package(root, "forbidden", &[], &[]);
        let selected_product = product(root, "selected-product", &[]);
        let set = authority(
            root,
            &[("selected", "user-software")],
            &[("selected-product", "selected", selected_product.as_path())],
            &[("forbidden", "forbidden prebuilt input")],
            &[],
        );
        assert!(
            load_and_plan(root, &set, &registry(root))
                .unwrap_err()
                .contains("reaches excluded package")
        );

        package(root, "unclassified", &[], &[]);
        assert!(
            load_and_plan(root, &set, &registry(root))
                .unwrap_err()
                .contains("unclassified registry root")
        );
    }

    #[test]
    fn rejects_excluded_source_dependency_before_kind_specific_scheduling() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "selected", &[], &[("source-input", "1.0.0")]);
        source_package(root, "source-input");
        let selected_product = product(root, "selected-product", &[]);
        let set = authority(
            root,
            &[("selected", "user-software")],
            &[("selected-product", "selected", selected_product.as_path())],
            &[("source-input", "forbidden source input")],
            &[],
        );

        let error = load_and_plan(root, &set, &registry(root)).unwrap_err();
        assert!(
            error.contains("reaches excluded package source-input"),
            "got: {error}",
        );
    }

    #[test]
    fn rejects_source_dependency_not_declared_dependency_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "selected", &[], &[("source-input", "1.0.0")]);
        source_package(root, "source-input");
        let selected_product = product(root, "selected-product", &[]);
        let set = authority(
            root,
            &[("selected", "user-software")],
            &[("selected-product", "selected", selected_product.as_path())],
            &[],
            &[],
        );
        let mut source = fs::read_to_string(&set)
            .unwrap()
            .replace("registry_non_roots = []\n", "");
        source.push_str(
            "\n[[registry_non_roots]]\nname = \"source-input\"\nreason = \"not a build root\"\n",
        );
        write(&set, &source);

        let error = load_and_plan(root, &set, &registry(root)).unwrap_err();
        assert!(
            error.contains("source package source-input that is not declared as dependency-only"),
            "got: {error}",
        );
    }

    #[test]
    fn rejects_selected_excluded_collision_unknown_package_and_missing_hook() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "selected", &[], &[]);
        let selected_product = product(root, "selected-product", &[]);
        let collision = authority(
            root,
            &[("selected", "user-software")],
            &[("selected-product", "selected", selected_product.as_path())],
            &[("selected", "cannot also be excluded")],
            &[],
        );
        assert!(
            load_and_plan(root, &collision, &registry(root))
                .unwrap_err()
                .contains("duplicate dispositions")
        );

        let unknown = authority(
            root,
            &[("missing", "user-software")],
            &[],
            &[("selected", "known but excluded")],
            &[],
        );
        assert!(
            load_and_plan(root, &unknown, &registry(root))
                .unwrap_err()
                .contains("unknown package")
        );

        let hook = root
            .join("packages/registry/selected")
            .join("build-selected.sh");
        fs::remove_file(hook).unwrap();
        let missing_hook = authority(
            root,
            &[("selected", "user-software")],
            &[("selected-product", "selected", selected_product.as_path())],
            &[],
            &[],
        );
        assert!(
            load_and_plan(root, &missing_hook, &registry(root))
                .unwrap_err()
                .contains("no effective build hook")
        );
    }

    #[test]
    fn rejects_unknown_products_and_package_or_product_cycles() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "a", &[], &[("b", "1.0.0")]);
        package(root, "b", &[], &[("a", "1.0.0")]);
        let known = product(root, "known", &[]);
        let package_cycle = authority(
            root,
            &[("a", "platform"), ("b", "platform")],
            &[("known", "a", known.as_path())],
            &[],
            &[],
        );
        assert!(
            load_and_plan(root, &package_cycle, &registry(root))
                .unwrap_err()
                .contains("cycle")
        );

        package(root, "a", &[], &[]);
        package(root, "b", &[], &[]);
        let first = product(root, "first", &["second"]);
        let second = product(root, "second", &["first"]);
        let product_cycle = authority(
            root,
            &[("a", "platform"), ("b", "platform")],
            &[
                ("first", "a", first.as_path()),
                ("second", "b", second.as_path()),
            ],
            &[],
            &[],
        );
        assert!(
            load_and_plan(root, &product_cycle, &registry(root))
                .unwrap_err()
                .contains("product composition cycle")
        );

        let known = product(root, "known", &[]);
        fs::remove_file(root.join(&first)).unwrap();
        fs::remove_file(root.join(&second)).unwrap();
        let unknown = authority(
            root,
            &[("a", "platform"), ("b", "platform")],
            &[("unknown", "a", known.as_path())],
            &[],
            &[],
        );
        assert!(
            load_and_plan(root, &unknown, &registry(root))
                .unwrap_err()
                .contains("unknown product")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_authority_and_product_manifest() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let target = root.join("target.toml");
        write(
            &target,
            "schema = 1\npolicy = \"source-only-v1\"\npackages=[]\nproducts=[]\nexclusions=[]\ndependency_only=[]\nregistry_non_roots=[]\ndormant_products=[]\n",
        );
        let authority_link = root.join("authority.toml");
        symlink(&target, &authority_link).unwrap();
        assert!(
            parse_supported_set(&authority_link)
                .unwrap_err()
                .contains("regular nonsymlink file")
        );

        package(root, "selected", &[], &[]);
        let product_target = product(root, "selected-product", &[]);
        let product_link = root.join("images/vfs/products/linked-product.toml");
        symlink(root.join(&product_target), &product_link).unwrap();
        let set = authority(
            root,
            &[("selected", "platform")],
            &[("selected-product", "selected", product_target.as_path())],
            &[],
            &[],
        );
        assert!(
            load_and_plan(root, &set, &registry(root))
                .unwrap_err()
                .contains("regular nonsymlink file")
        );
    }

    #[test]
    fn command_line_requires_exact_plan_and_set_pair() {
        for args in [
            vec![],
            vec!["plan".into()],
            vec!["plan".into(), "--set".into()],
            vec!["plan".into(), "--set".into(), "a".into(), "extra".into()],
            vec!["other".into(), "--set".into(), "a".into()],
        ] {
            assert!(run(args).is_err());
        }
    }

    #[test]
    fn local_source_provider_requires_explicit_selected_and_dependency_only_manifests() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "selected", &[], &[]);
        source_package(root, "source-input");
        let set_path = authority(
            root,
            &[("selected", "platform")],
            &[],
            &[],
            &["source-input"],
        );
        let set = parse_supported_set(&set_path).unwrap();

        let selected_path = root.join("packages/registry/selected/package.toml");
        let selected = fs::read_to_string(&selected_path).unwrap();
        fs::write(
            &selected_path,
            selected.replace("provider = \"repository\"\n", ""),
        )
        .unwrap();
        let manifests = registry(root).walk_all().unwrap().into_iter().collect();
        let error = validate_registry_partition(&set, &manifests, root).unwrap_err();
        assert!(
            error.contains("selected") && error.contains("explicit"),
            "{error}"
        );

        fs::write(&selected_path, selected).unwrap();
        let source_path = root.join("packages/registry/source-input/package.toml");
        let source = fs::read_to_string(&source_path).unwrap();
        fs::write(&source_path, source.replace("provider = \"archive\"\n", "")).unwrap();
        let manifests = registry(root).walk_all().unwrap().into_iter().collect();
        let error = validate_registry_partition(&set, &manifests, root).unwrap_err();
        assert!(
            error.contains("source-input") && error.contains("explicit"),
            "{error}"
        );
    }

    #[test]
    fn local_source_provider_leaves_excluded_legacy_inference_parseable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        package(root, "legacy", &[], &[]);
        let manifest_path = root.join("packages/registry/legacy/package.toml");
        let source = fs::read_to_string(&manifest_path)
            .unwrap()
            .replace("provider = \"repository\"\n", "");
        fs::write(&manifest_path, source).unwrap();
        let set_path = authority(root, &[], &[], &[("legacy", "legacy boundary")], &[]);
        let set = parse_supported_set(&set_path).unwrap();
        let manifests: BTreeMap<_, _> = registry(root).walk_all().unwrap().into_iter().collect();

        assert_eq!(
            manifests["legacy"].source.provider,
            SourceProvider::Repository
        );
        assert!(!manifests["legacy"].source.provider_was_explicit);
        validate_registry_partition(&set, &manifests, root).unwrap();
    }
}
