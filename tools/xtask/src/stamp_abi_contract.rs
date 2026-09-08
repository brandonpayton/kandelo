//! `stamp-abi-contract <wasm>...` — append the `kandelo.abi.contract`
//! stamp to wasm programs built outside the local-build engine (e.g. Rust
//! programs from `wasm32posix-cargo`).
//!
//! It reuses the engine's exact `local_abi_contract_digest` (derived from
//! `abi/snapshot.json` and `ABI_VERSION`), so a stamped Rust program
//! carries the same contract digest the host verifies at exec — no
//! best-effort, no divergent value. Refuses to double-stamp (a fresh build
//! is unstamped; rebuild rather than re-stamp).

use crate::repo_root;

pub(crate) fn run(args: Vec<String>) -> Result<(), String> {
    if args.is_empty() {
        return Err("usage: xtask stamp-abi-contract <wasm>...".to_string());
    }
    let root = repo_root();
    let abi_version = wasm_posix_shared::ABI_VERSION;
    let digest = crate::local_abi_identity::local_abi_contract_digest(&root, abi_version)?;

    for wasm_path in &args {
        let bytes = std::fs::read(wasm_path)
            .map_err(|error| format!("read {wasm_path}: {error}"))?;
        let stamped = crate::build_stamp::stamp_named_section(
            &bytes,
            crate::build_stamp::ABI_CONTRACT_SECTION,
            &digest,
        )?;
        std::fs::write(wasm_path, &stamped)
            .map_err(|error| format!("write {wasm_path}: {error}"))?;
        eprintln!("stamped {} bytes -> {wasm_path}", stamped.len());
    }
    Ok(())
}
