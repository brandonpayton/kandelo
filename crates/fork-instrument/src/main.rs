//! CLI frontend for `fork-instrument`.
//!
//! Usage:
//!
//! ```text
//! wasm-fork-instrument <input.wasm> -o <output.wasm> [--entry kernel.kernel_fork]
//! ```
//!
//! Exits non-zero with a human-readable error on any failure (parse,
//! validation, or instrumentation). Errors include the input file path
//! and the operation that failed.

use anyhow::{Context, Result};
use clap::Parser;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use fork_instrument::{
    Options, analyze,
    contract_inventory::{
        artifact_identity, fork_capability_section_hex, fork_contract_inventory,
        linked_frame_descriptor_section_hex, reserved_env_imports,
    },
    instrument,
};

#[derive(Debug, Parser)]
#[command(
    name = "wasm-fork-instrument",
    about = "Instrument a wasm module with save/restore machinery for POSIX fork()",
    long_about = None,
)]
struct Cli {
    /// Input wasm file to instrument.
    input: PathBuf,

    /// Output path for the instrumented wasm file. Required unless an
    /// analysis or contract-inspection mode is set.
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// The fully-qualified name of the import that triggers unwind.
    /// Format: `module.field`. Defaults to `kernel.kernel_fork`.
    /// `env.fork` selects complete dynamically linked side-module boundary
    /// coverage, including downstream fork in another side module.
    #[arg(long, default_value = "kernel.kernel_fork")]
    entry: String,

    /// Analyze the module and print the discovered fork-path function
    /// set as JSON to stdout. Skips instrumentation and output emission.
    /// Useful for validating call-graph discovery against
    /// hand-maintained onlylists.
    #[arg(long)]
    discover_only: bool,

    /// Print the fork-artifact structural inventory as one TSV row.
    /// This mode performs no instrumentation and emits no output file.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "artifact_identity",
            "reserved_env_imports",
            "output"
        ]
    )]
    contract_inventory: bool,

    /// Print relocatable, memory, and strict ABI-export identity as one TSV row.
    /// This mode performs no instrumentation and emits no output file.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "fork_capability_hex",
            "linked_frame_descriptor_hex",
            "reserved_env_imports",
            "output"
        ]
    )]
    artifact_identity: bool,

    /// Print the unique fork-capability custom section as lowercase hex.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "linked_frame_descriptor_hex",
            "reserved_env_imports",
            "output"
        ]
    )]
    fork_capability_hex: bool,

    /// Print the unique linked-frame descriptor custom section as lowercase hex.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "reserved_env_imports",
            "output"
        ]
    )]
    linked_frame_descriptor_hex: bool,

    /// Print reserved env imports as `<kind>\t<module>.<name>` rows.
    #[arg(
        long,
        conflicts_with_all = [
            "discover_only",
            "contract_inventory",
            "artifact_identity",
            "fork_capability_hex",
            "linked_frame_descriptor_hex",
            "output"
        ]
    )]
    reserved_env_imports: bool,

    /// TEST-ONLY: force the emitted artifact's `__abi_version` export to this
    /// instrumenter's compiled-in current ABI, overwriting a stale marker or
    /// adding a missing one, regardless of side-module-ness. It stamps the
    /// CURRENT (correct) epoch, so it auto-tracks future ABI bumps.
    ///
    /// Do NOT use this in production build paths: real programs get
    /// `__abi_version` from the libc syscall glue plus the linker export, and a
    /// missing or mismatched marker on a real artifact is a genuine defect the
    /// host must keep rejecting. This flag exists only so hand-authored
    /// fork-continuation test fixtures (whose committed sources declare a fixed
    /// historical ABI) can track the current ABI epoch without being
    /// regenerated on every bump.
    #[arg(long)]
    stamp_abi_version: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    let input =
        fs::read(&cli.input).with_context(|| format!("reading input: {}", cli.input.display()))?;

    if cli.contract_inventory {
        let inventory = fork_contract_inventory(&input)
            .with_context(|| format!("inventorying {}", cli.input.display()))?;
        println!("{inventory}");
        return Ok(());
    }
    if cli.artifact_identity {
        let identity = artifact_identity(&input)
            .with_context(|| format!("inspecting artifact identity: {}", cli.input.display()))?;
        println!("{identity}");
        return Ok(());
    }
    if cli.fork_capability_hex {
        let hex = fork_capability_section_hex(&input)
            .with_context(|| format!("reading fork capability: {}", cli.input.display()))?;
        println!("{hex}");
        return Ok(());
    }
    if cli.linked_frame_descriptor_hex {
        let hex = linked_frame_descriptor_section_hex(&input)
            .with_context(|| format!("reading linked-frame descriptor: {}", cli.input.display()))?;
        println!("{hex}");
        return Ok(());
    }
    if cli.reserved_env_imports {
        let imports = reserved_env_imports(&input)
            .with_context(|| format!("inventorying reserved imports: {}", cli.input.display()))?;
        for import in imports {
            println!("{}\t{}", import.kind, import.identity);
        }
        return Ok(());
    }

    let opts = Options {
        entry_import: cli.entry,
        stamp_abi_version: cli.stamp_abi_version,
    };

    if cli.discover_only {
        let analysis =
            analyze(&input, &opts).with_context(|| format!("analyzing {}", cli.input.display()))?;
        print_analysis_json(&analysis);
        return Ok(());
    }

    let output_path = cli.output.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "--output is required unless an analysis or contract-inspection mode is set"
        )
    })?;
    // Capture this before writing: `--output` is allowed to name the input
    // file, and output creation/truncation must not become the source of truth
    // for the executable mode we are preserving.
    let input_mode = input_mode(&cli.input)?;

    let output = instrument(&input, &opts)
        .with_context(|| format!("instrumenting {}", cli.input.display()))?;

    fs::write(output_path, &output)
        .with_context(|| format!("writing output: {}", output_path.display()))?;
    preserve_input_mode(input_mode, output_path)?;

    Ok(())
}

#[cfg(unix)]
fn input_mode(input_path: &Path) -> Result<u32> {
    let mode = fs::metadata(input_path)
        .with_context(|| format!("stat input for permissions: {}", input_path.display()))?
        .permissions()
        .mode();
    Ok(mode)
}

#[cfg(not(unix))]
fn input_mode(_input_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn preserve_input_mode(input_mode: u32, output_path: &Path) -> Result<()> {
    let permissions = fs::Permissions::from_mode(input_mode);
    fs::set_permissions(output_path, permissions)
        .with_context(|| format!("setting output permissions: {}", output_path.display()))?;
    Ok(())
}

#[cfg(not(unix))]
fn preserve_input_mode(_input_mode: (), _output_path: &Path) -> Result<()> {
    Ok(())
}

fn print_analysis_json(analysis: &fork_instrument::Analysis) {
    // Hand-rolled JSON to avoid a serde dependency for a tiny output.
    // Format is one-entry-per-line array of `{name, is_import}` objects.
    println!("{{");
    println!("  \"fork_path\": [");
    for (i, entry) in analysis.fork_path.iter().enumerate() {
        let comma = if i + 1 == analysis.fork_path.len() {
            ""
        } else {
            ","
        };
        println!(
            "    {{ \"name\": {}, \"is_import\": {} }}{}",
            json_string(&entry.name),
            entry.is_import,
            comma,
        );
    }
    println!("  ],");
    println!("  \"count\": {}", analysis.fork_path.len());
    println!("}}");
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
