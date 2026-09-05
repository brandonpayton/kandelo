use std::fs;
use std::path::PathBuf;
use std::process::Command;

const INPUT_WAT: &str = r#"
(module
  (import "kernel" "kernel_checkpoint" (func $checkpoint))
  (memory 1)
  (func $syscaller (export "_start")
    call $checkpoint))
"#;

fn write_module() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "kandelo-checkpoint-seed-cli-{}.wasm",
        std::process::id()
    ));
    fs::write(&path, wat::parse_str(INPUT_WAT).expect("compile WAT")).expect("write module");
    path
}

fn discover(path: &PathBuf, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_wasm-fork-instrument"))
        .arg("--discover-only")
        .args(args)
        .arg(path)
        .output()
        .expect("run discovery CLI")
}

#[test]
fn checkpoint_entry_flag_seeds_discovery_in_a_module_that_never_forks() {
    let path = write_module();

    let without = discover(&path, &[]);
    assert!(
        !without.status.success(),
        "no seed import should fail discovery"
    );

    let with = discover(&path, &["--checkpoint-entry", "kernel.kernel_checkpoint"]);
    assert!(
        with.status.success(),
        "discovery failed: {}",
        String::from_utf8_lossy(&with.stderr)
    );
    let stdout = String::from_utf8(with.stdout).expect("UTF-8 analysis");
    assert!(stdout.contains("syscaller"), "got {stdout}");

    fs::remove_file(&path).expect("remove module");
}
