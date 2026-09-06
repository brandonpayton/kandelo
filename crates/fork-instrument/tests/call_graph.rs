//! Tests for semantic fork call-graph discovery.
//!
//! Each fixture is a small WAT module whose structure lets us assert
//! exactly which activations can survive while execution reaches the
//! `kernel.kernel_fork` import through direct, table, typed-ref, or tail edges.

use fork_instrument::{
    Options, analyze,
    call_graph::{self, TailCallKind},
};
use std::collections::HashSet;

fn discover(wat_src: &str) -> HashSet<String> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    let analysis = analyze(&bytes, &Options::default()).expect("analyze");
    analysis.fork_path.iter().map(|e| e.name.clone()).collect()
}

fn discover_semantic_activations(wat_src: &str) -> HashSet<String> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    let module = walrus::Module::from_buffer(&bytes).expect("walrus parse");
    let seed =
        call_graph::find_import_func(&module, "kernel.kernel_fork").expect("fork seed import");
    call_graph::analyze_reaching_closure(&module, seed)
        .activations
        .into_iter()
        .map(|id| call_graph::func_display_name(&module, id))
        .collect()
}

fn discover_tail_landings(wat_src: &str) -> HashSet<(String, TailCallKind)> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    let module = walrus::Module::from_buffer(&bytes).expect("walrus parse");
    let seed =
        call_graph::find_import_func(&module, "kernel.kernel_fork").expect("fork seed import");
    call_graph::analyze_reaching_closure(&module, seed)
        .tail_call_landings
        .into_iter()
        .map(|site| {
            (
                call_graph::func_display_name(&module, site.caller),
                site.kind,
            )
        })
        .collect()
}

#[test]
fn seed_alone_when_nothing_calls_fork() {
    // No function in the module calls $fork. The result should just be
    // the seed import itself.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (result i32)
            i32.const 0)
          (func $b (result i32)
            call $a))
    "#;
    let found = discover(wat);
    // Only the seed should be reported: nothing else reaches it.
    assert_eq!(found.len(), 1, "expected seed alone; got {found:?}");
}

#[test]
fn direct_caller_included() {
    // $a calls $fork directly; nothing calls $a. Result: {$fork, $a}.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (export "a") (result i32)
            call $fork))
    "#;
    let found = discover(wat);
    assert_eq!(
        found.len(),
        2,
        "expected seed + one direct caller, got {found:?}"
    );
    assert!(found.iter().any(|n| n == "a"));
}

#[test]
fn transitive_chain() {
    // main -> middle -> leaf -> fork. All four should be reported.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $leaf (export "leaf") (result i32)
            call $fork)
          (func $middle (export "middle") (result i32)
            call $leaf)
          (func $main (export "main") (result i32)
            call $middle))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 4, "got {found:?}");
    for name in ["leaf", "middle", "main"] {
        assert!(found.iter().any(|n| n == name), "missing {name}");
    }
}

#[test]
fn unrelated_function_excluded() {
    // $a reaches fork; $unrelated does not. Only $a and fork reported.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (export "a") (result i32)
            call $fork)
          (func $unrelated (export "unrelated") (result i32)
            i32.const 42))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 2, "got {found:?}");
    assert!(found.iter().any(|n| n == "a"));
    assert!(!found.iter().any(|n| n == "unrelated"));
}

#[test]
fn diamond_shape() {
    // main calls both $left and $right, both of which reach fork.
    // main should appear exactly once in the result, plus left, right,
    // fork. (Verifies BFS doesn't double-count.)
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $left (export "left") (result i32)
            call $fork)
          (func $right (export "right") (result i32)
            call $fork)
          (func $main (export "main") (result i32)
            call $left
            drop
            call $right))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 4, "got {found:?}");
    for name in ["left", "right", "main"] {
        assert!(found.iter().any(|n| n == name));
    }
}

#[test]
fn missing_entry_import_is_an_error() {
    // Module has no fork import at all. Must fail loudly rather than
    // silently produce an empty set.
    let wat = r#"
        (module
          (func $a (export "a") (result i32) i32.const 0))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let err = analyze(&bytes, &Options::default()).unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("kernel.kernel_fork") && msg.contains("not found"),
        "expected a helpful missing-import error, got: {msg}"
    );
}

#[test]
fn lowered_legacy_loader_is_a_boundary_without_a_direct_fork_import() {
    let wat = r#"
        (module
          (import "env" "__wasm_dlopen"
            (func $legacy (param i32 i32) (result i32)))
          (memory 1)
          (table (export "__indirect_function_table") 1 funcref)
          (func $open_side (export "open_side") (result i32)
            i32.const 100
            i32.const 20
            call $legacy))
    "#;
    let found = discover(wat);
    assert!(
        found.contains("open_side"),
        "the caller remains live while the generated driver invokes a side initializer: {found:?}",
    );
    assert!(
        found.contains("__wpk_fork_legacy_dlopen_driver"),
        "the staged driver's external call_indirect is the suspension boundary: {found:?}",
    );
}

#[test]
fn custom_entry_import_name() {
    // The entry import is configurable; verify.
    let wat = r#"
        (module
          (import "host" "do_async" (func $async (result i32)))
          (func $a (export "a") (result i32)
            call $async))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let opts = Options {
        entry_import: "host.do_async".into(),
        ..Options::default()
    };
    let analysis = analyze(&bytes, &opts).expect("analyze");
    assert_eq!(analysis.fork_path.len(), 2);
    assert!(analysis.fork_path.iter().any(|e| e.name == "a"));
}

#[test]
fn a_checkpoint_seed_adds_to_the_entry_seed_rather_than_replacing_it() {
    // The closure is walked from a seed's callers, so an import joins it only
    // by being a seed itself. Naming the checkpoint import through
    // `entry_import` would drop the fork boundary, leaving its call site
    // without unwind transport.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
          (import "kernel" "kernel_checkpoint" (func $checkpoint))
          (func $forker (export "forker") (result i32)
            i32.const 0
            call $fork)
          (func $syscaller (export "syscaller")
            call $checkpoint))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let opts = Options {
        checkpoint_import: Some("kernel.kernel_checkpoint".into()),
        ..Options::default()
    };
    let analysis = analyze(&bytes, &opts).expect("analyze");
    let found: HashSet<String> = analysis.fork_path.iter().map(|e| e.name.clone()).collect();
    for name in ["fork", "forker", "checkpoint", "syscaller"] {
        assert!(found.contains(name), "got {found:?}");
    }
}

#[test]
fn a_checkpoint_seed_is_the_only_seed_a_program_that_never_forks_has() {
    let wat = r#"
        (module
          (import "kernel" "kernel_checkpoint" (func $checkpoint))
          (func $syscaller (export "syscaller")
            call $checkpoint))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    analyze(&bytes, &Options::default())
        .expect_err("no fork import means there is nothing to instrument");

    let opts = Options {
        checkpoint_import: Some("kernel.kernel_checkpoint".into()),
        ..Options::default()
    };
    let analysis = analyze(&bytes, &opts).expect("analyze");
    let found: HashSet<String> = analysis.fork_path.iter().map(|e| e.name.clone()).collect();
    for name in ["checkpoint", "syscaller"] {
        assert!(found.contains(name), "got {found:?}");
    }
}

#[test]
fn a_missing_checkpoint_seed_is_named_alongside_the_entry_seed() {
    let wat = r#"
        (module
          (import "kernel" "kernel_other" (func $other (result i32)))
          (func $caller (export "caller") (result i32)
            call $other))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let opts = Options {
        checkpoint_import: Some("kernel.kernel_checkpoint".into()),
        ..Options::default()
    };
    let message = analyze(&bytes, &opts)
        .expect_err("neither seed is present")
        .to_string();
    assert!(message.contains("`kernel.kernel_fork`"), "got {message}");
    assert!(
        message.contains("`kernel.kernel_checkpoint`"),
        "got {message}"
    );
}

#[test]
fn a_checkpoint_seed_naming_the_entry_import_seeds_it_once() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
          (func $forker (export "forker") (result i32)
            i32.const 0
            call $fork))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let opts = Options {
        checkpoint_import: Some("kernel.kernel_fork".into()),
        ..Options::default()
    };
    let analysis = analyze(&bytes, &opts).expect("analyze");
    let names: Vec<String> = analysis.fork_path.iter().map(|e| e.name.clone()).collect();
    let unique: HashSet<String> = names.iter().cloned().collect();
    assert_eq!(names.len(), unique.len(), "got {names:?}");
    assert_eq!(
        unique,
        analyze(&bytes, &Options::default())
            .expect("analyze")
            .fork_path
            .iter()
            .map(|e| e.name.clone())
            .collect::<HashSet<String>>()
    );
}

#[test]
fn duplicate_entry_import_declarations_are_all_roots() {
    // A module/name pair is not a unique function identity in Wasm. Both
    // declarations can be called by different live activations and therefore
    // must seed the configured main-module closure.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork0 (result i32)))
          (import "kernel" "kernel_fork" (func $fork1 (param i32) (result i32)))
          (func $calls_first (export "calls_first") (result i32)
            call $fork0)
          (func $calls_second (export "calls_second") (result i32)
            i32.const 7
            call $fork1))
    "#;
    let found = discover(wat);
    assert!(
        found.contains("calls_first"),
        "first declaration caller: {found:?}"
    );
    assert!(
        found.contains("calls_second"),
        "second declaration caller: {found:?}"
    );
    assert_eq!(
        found.len(),
        4,
        "both imports and both callers must be present: {found:?}"
    );
}

#[test]
fn dylink_side_module_covers_every_cross_module_boundary() {
    // Side A can remain live while an imported function in side B forks even
    // though A has no env.fork import. An unresolved table/reference dispatch
    // can cross the same boundary. Tail callers remain transparent, but their
    // older ordinary callers still own resumable activation frames.
    let wat = r#"
        (module
          (@custom "dylink.0" (before first) "side")
          (type $ft (func (result i32)))
          (import "env" "side_b" (func $side_b (type $ft)))
          (table $dispatch 1 funcref)
          (func $direct (export "direct") (result i32)
            call $side_b)
          (func $direct_parent (export "direct_parent") (result i32)
            call $direct)
          (func $indirect (export "indirect") (result i32)
            i32.const 0
            call_indirect $dispatch (type $ft))
          (func $reference (export "reference")
            (param $callee (ref null $ft)) (result i32)
            local.get $callee
            call_ref $ft)
          (func $tail_import (export "tail_import") (result i32)
            return_call $side_b)
          (func $tail_parent (export "tail_parent") (result i32)
            call $tail_import)
          (func $unrelated (export "unrelated") (result i32)
            i32.const 42))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let analysis = analyze(&bytes, &Options::default()).expect("side-boundary analysis");
    let found: HashSet<_> = analysis
        .fork_path
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();

    for expected in [
        "direct",
        "direct_parent",
        "indirect",
        "reference",
        "tail_parent",
    ] {
        assert!(
            found.contains(expected),
            "{expected} must be activation-owned above a cross-module boundary: {found:?}"
        );
    }
    assert!(
        !found.contains("tail_import"),
        "a true tail caller has no surviving activation: {found:?}"
    );
    assert!(
        !found.contains("unrelated"),
        "a static local leaf must retain zero instrumentation overhead: {found:?}"
    );
}

#[test]
fn cycle_terminates() {
    // $a calls $b, $b calls $a, $b calls $fork. Cycle must not loop.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (export "a") (result i32)
            call $b)
          (func $b (export "b") (result i32)
            call $a
            drop
            call $fork))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 3, "got {found:?}");
    assert!(found.iter().any(|n| n == "a"));
    assert!(found.iter().any(|n| n == "b"));
}

#[test]
fn indirect_call_to_fork_path_target_is_followed() {
    // $forks_via_indirect is in a table and reaches fork directly.
    // $calls_indirect does call_indirect of the same signature.
    // Phase 3: $calls_indirect must be added because the table
    // target it might dispatch to is on the fork path.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $forks_via_indirect)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        found.iter().any(|n| n == "calls_indirect"),
        "Phase 3: call_indirect caller must be added when its possible \
         target is on the fork path; got {found:?}"
    );
}

#[test]
fn indirect_call_with_mismatched_signature_not_followed() {
    // $forks_via_indirect reaches fork and is in the table with type
    // (result i32). $calls_indirect_wrong_sig does call_indirect with
    // a different signature (param i32). Different signature, so its
    // call_indirect cannot actually target $forks_via_indirect;
    // instrumenting it would be overly conservative.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft_a (func (result i32)))
          (type $ft_b (func (param i32)))
          (table 1 funcref)
          (elem (i32.const 0) $forks_via_indirect)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_indirect_wrong_sig (export "calls_indirect_wrong_sig")
            i32.const 0
            i32.const 0
            call_indirect (type $ft_b)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        !found.iter().any(|n| n == "calls_indirect_wrong_sig"),
        "signature mismatch must not force instrumentation; got {found:?}"
    );
}

#[test]
fn indirect_to_direct_to_fork_chain() {
    //   main → calls_indirect ⇝(type $ft)⇝ target → fork
    //
    // The chain requires: main (direct), calls_indirect (direct to
    // main's pov), target (via table + matching signature), fork.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $target)
          (func $target (export "target") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft))
          (func $main (export "main") (result i32)
            call $calls_indirect))
    "#;
    let found = discover(wat);
    for name in ["target", "calls_indirect", "main"] {
        assert!(found.iter().any(|n| n == name), "missing {name}: {found:?}");
    }
}

#[test]
fn function_not_in_any_table_is_not_an_indirect_target() {
    // $fn_with_matching_sig has the same signature as $calls_indirect's
    // call_indirect, BUT it's not in any table. So it's not a possible
    // target and should not be dragged in via indirect closure.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $some_other_target)
          (func $some_other_target (export "some_other_target") (result i32)
            i32.const 0)
          (func $fn_with_matching_sig (export "fn_with_matching_sig") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    // $fn_with_matching_sig reaches fork directly (calls it).
    assert!(found.iter().any(|n| n == "fn_with_matching_sig"));
    // $some_other_target is in the table and has matching signature,
    // but it doesn't reach fork — so the indirect closure has nothing
    // to pull in through $calls_indirect.
    assert!(
        !found.iter().any(|n| n == "calls_indirect"),
        "call_indirect target is in the table but doesn't reach fork; \
         caller should not be pulled in: {found:?}"
    );
    assert!(
        !found.iter().any(|n| n == "some_other_target"),
        "irrelevant table function should not appear: {found:?}"
    );
}

#[test]
fn indirect_call_on_different_table_not_followed() {
    // $forks_via_indirect is table-addressable, but only through
    // $fork_table. A call_indirect against $safe_table cannot dispatch
    // to it even though the signature matches.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table $safe_table 1 funcref)
          (table $fork_table 1 funcref)
          (elem (table $safe_table) (i32.const 0) func $safe_target)
          (elem (table $fork_table) (i32.const 0) func $forks_via_indirect)
          (func $safe_target (result i32)
            i32.const 0)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_safe_table (export "calls_safe_table") (result i32)
            i32.const 0
            call_indirect $safe_table (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        !found.iter().any(|n| n == "calls_safe_table"),
        "call_indirect must be scoped to its table; got {found:?}"
    );
}

#[test]
fn declared_element_is_not_an_indirect_table_target() {
    // A declared element segment makes ref.func valid but does not
    // initialize a table. Treating it as table-addressable makes every
    // same-signature call_indirect a false positive.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem declare func $declared_fork_target)
          (func $declared_fork_target (export "declared_fork_target") (result i32)
            call $fork)
          (func $calls_table (export "calls_table") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "declared_fork_target"));
    assert!(
        !found.iter().any(|n| n == "calls_table"),
        "declared elements do not populate an indirect-call table; got {found:?}"
    );
}

#[test]
fn passive_element_without_table_init_is_not_followed() {
    // A passive element segment is not a call_indirect target unless
    // some code can copy it into a table with table.init.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem $passive func $passive_fork_target)
          (func $passive_fork_target (export "passive_fork_target") (result i32)
            call $fork)
          (func $calls_table (export "calls_table") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "passive_fork_target"));
    assert!(
        !found.iter().any(|n| n == "calls_table"),
        "passive segment without table.init should not be treated as table-populating; got {found:?}"
    );
}

#[test]
fn passive_element_with_table_init_is_followed() {
    // Once a passive element can initialize a table, matching call_indirect
    // users of that same table remain fork-path callers.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table $t 1 funcref)
          (elem $passive func $passive_fork_target)
          (func $init_table
            i32.const 0
            i32.const 0
            i32.const 1
            table.init $t $passive)
          (func $passive_fork_target (export "passive_fork_target") (result i32)
            call $fork)
          (func $calls_table (export "calls_table") (result i32)
            i32.const 0
            call_indirect $t (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "passive_fork_target"));
    assert!(
        found.iter().any(|n| n == "calls_table"),
        "table.init makes the passive target reachable through that table; got {found:?}"
    );
}

#[test]
fn dynamic_linker_indirect_call_is_conservative_fork_boundary() {
    // Side-module functions inserted after instrumentation are absent from
    // every static element segment. A dlopen-capable main must still preserve
    // the call_indirect frame and its direct callers when that side function
    // later reaches fork().
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
          (type $side_fn_ty (func (result i32)))
          (table $t 1 funcref)
          (func $dispatch_side_callback (export "dispatch_side_callback") (result i32)
            i32.const 0
            call_indirect $t (type $side_fn_ty))
          (func $parent_frame (export "parent_frame") (result i32)
            call $dispatch_side_callback)
          (func $ordinary (export "ordinary") (result i32)
            i32.const 7))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "dispatch_side_callback"));
    assert!(found.iter().any(|n| n == "parent_frame"));
    assert!(
        !found.iter().any(|n| n == "ordinary"),
        "unrelated functions must stay out of the dynamic fork closure: {found:?}"
    );
}

#[test]
fn dynamic_linker_host_calls_are_direct_fork_boundaries() {
    // dlopen can synchronously enter a side module's deferred start and
    // constructors. The main activation at the host import therefore survives
    // a downstream side-module fork even when it performs no table dispatch.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (import "env" "__wasm_dlopen"
            (func $dlopen (param i32 i32 i32 i32) (result i32)))
          (func $open_side (export "open_side") (result i32)
            i32.const 100
            i32.const 20
            i32.const 200
            i32.const 10
            call $dlopen)
          (func $open_parent (export "open_parent") (result i32)
            call $open_side)
          (func $ordinary (export "ordinary") (result i32)
            i32.const 7))
    "#;
    let found = discover(wat);
    assert!(
        found.contains("open_side"),
        "dlopen caller must survive: {found:?}"
    );
    assert!(
        found.contains("open_parent"),
        "ordinary callers above dlopen must survive: {found:?}"
    );
    assert!(
        !found.contains("ordinary"),
        "unrelated local work must stay outside the closure: {found:?}"
    );
}

#[test]
fn constant_slot_pointing_to_safe_target_excludes_indirect_caller() {
    // Both functions have the same signature and inhabit the same table.
    // The caller indexes slot 0, which can only dispatch to $safe_target,
    // so $calls_safe_slot must not be treated as reaching $fork_target.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 2 funcref)
          (elem (i32.const 0) $safe_target $fork_target)
          (func $safe_target (export "safe_target") (result i32)
            i32.const 0)
          (func $fork_target (export "fork_target") (result i32)
            call $fork)
          (func $calls_safe_slot (export "calls_safe_slot") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "fork_target"));
    assert!(
        !found.iter().any(|n| n == "calls_safe_slot"),
        "literal index 0 cannot dispatch to the fork target in slot 1; got {found:?}"
    );
}

#[test]
fn constant_slot_pointing_to_fork_target_includes_indirect_caller() {
    // The precise slot model must still include a caller when its literal
    // index points at the fork-reaching table entry.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 2 funcref)
          (elem (i32.const 0) $safe_target $fork_target)
          (func $safe_target (result i32)
            i32.const 0)
          (func $fork_target (export "fork_target") (result i32)
            call $fork)
          (func $calls_fork_slot (export "calls_fork_slot") (result i32)
            i32.const 1
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "fork_target"));
    assert!(
        found.iter().any(|n| n == "calls_fork_slot"),
        "literal index 1 dispatches to the fork target; got {found:?}"
    );
}

#[test]
fn constant_index_folded_from_i32_add_uses_slot_model() {
    // The index proof is intentionally tiny, but folding adjacent constants
    // avoids losing precision for common lowered arithmetic.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 3 funcref)
          (elem (i32.const 0) $safe_a $safe_b $fork_target)
          (func $safe_a (result i32)
            i32.const 0)
          (func $safe_b (result i32)
            i32.const 1)
          (func $fork_target (export "fork_target") (result i32)
            call $fork)
          (func $calls_folded_safe_slot (export "calls_folded_safe_slot") (result i32)
            i32.const 0
            i32.const 1
            i32.add
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "fork_target"));
    assert!(
        !found.iter().any(|n| n == "calls_folded_safe_slot"),
        "folded index 1 points at a safe slot, not the fork target in slot 2; got {found:?}"
    );
}

#[test]
fn unknown_index_against_table_with_fork_target_includes_indirect_caller() {
    // A local value could be any in-bounds table index, so this remains
    // conservative even when the table contents are slot-known.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 2 funcref)
          (elem (i32.const 0) $safe_target $fork_target)
          (func $safe_target (result i32)
            i32.const 0)
          (func $fork_target (export "fork_target") (result i32)
            call $fork)
          (func $calls_unknown_index (export "calls_unknown_index") (param i32) (result i32)
            local.get 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "fork_target"));
    assert!(
        found.iter().any(|n| n == "calls_unknown_index"),
        "dynamic table index must stay conservative; got {found:?}"
    );
}

#[test]
fn dynamic_table_write_preserves_conservative_indirect_inclusion() {
    // table.set may rewrite slot 0 before the indirect call. Until the
    // analyser has ordered table-write proofs, the whole table is unknown.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 2 funcref)
          (elem (i32.const 0) $safe_target $fork_target)
          (func $safe_target (result i32)
            i32.const 0)
          (func $fork_target (export "fork_target") (result i32)
            call $fork)
          (func $rewrite_table
            i32.const 0
            ref.func $fork_target
            table.set 0)
          (func $calls_slot_zero (export "calls_slot_zero") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "fork_target"));
    assert!(
        found.iter().any(|n| n == "calls_slot_zero"),
        "dynamic table writes keep literal indexes conservative; got {found:?}"
    );
}

#[test]
fn call_ref_uses_precise_ref_func_provenance_when_available() {
    // Both possible targets have the same type. Immediate ref.func provenance
    // proves that one call is safe and the other reaches fork, avoiding the
    // all-compatible fallback for these statically named callees.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (elem declare func $safe_target $fork_target)
          (func $safe_target (result i32)
            i32.const 7)
          (func $fork_target (result i32)
            call $fork)
          (func $calls_safe_ref (export "calls_safe_ref") (result i32)
            ref.func $safe_target
            call_ref $ft)
          (func $calls_fork_ref (export "calls_fork_ref") (result i32)
            ref.func $fork_target
            call_ref $ft))
    "#;
    let found = discover(wat);
    assert!(found.contains("calls_fork_ref"), "{found:?}");
    assert!(
        !found.contains("calls_safe_ref"),
        "precise ref.func must not become an all-signature edge: {found:?}"
    );
}

#[test]
fn call_ref_with_unknown_provenance_includes_all_type_compatible_targets() {
    // A reference parameter can name any compatible function. Once a
    // compatible target reaches fork, the caller must be in the closure.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (func $fork_target (type $ft) (result i32)
            call $fork)
          (func $calls_unknown_ref
            (export "calls_unknown_ref")
            (param (ref null $ft))
            (result i32)
            local.get 0
            call_ref $ft))
    "#;
    let found = discover(wat);
    assert!(
        found.contains("calls_unknown_ref"),
        "unknown call_ref provenance must cover compatible fork targets: {found:?}"
    );
}

#[test]
fn call_ref_unknown_provenance_honors_declared_function_subtyping() {
    // call_ref $base accepts a ref to a declared subtype. Exact TypeId or
    // structural-equality-only matching would miss this valid dispatch edge.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $base (sub (func (result i32))))
          (type $derived (sub $base (func (result i32))))
          (func $derived_target (type $derived) (result i32)
            call $fork)
          (func $calls_base_ref
            (export "calls_base_ref")
            (param (ref null $base))
            (result i32)
            local.get 0
            call_ref $base))
    "#;
    let found = discover(wat);
    assert!(
        found.contains("calls_base_ref"),
        "declared function subtype must satisfy the call_ref edge: {found:?}"
    );
}

#[test]
fn direct_indirect_and_call_ref_edges_share_one_fixed_point() {
    // target -> call_ref caller -> call_indirect caller -> direct caller.
    // Computing each edge class only once, in phases, would miss the outer
    // activations after a later edge class discovers a new inner function.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $target_ty (func (result i32)))
          (type $ref_caller_ty (func (result i64)))
          (table 1 funcref)
          (elem (i32.const 0) $ref_caller)
          (elem declare func $target)
          (func $target (type $target_ty) (result i32)
            call $fork)
          (func $ref_caller (type $ref_caller_ty) (result i64)
            ref.func $target
            call_ref $target_ty
            drop
            i64.const 1)
          (func $indirect_caller (export "indirect_caller") (result i64)
            i32.const 0
            call_indirect (type $ref_caller_ty))
          (func $outer (export "outer") (result i64)
            call $indirect_caller))
    "#;
    let found = discover(wat);
    for name in ["target", "ref_caller", "indirect_caller", "outer"] {
        assert!(
            found.contains(name),
            "mixed-edge fixed point missed {name}: {found:?}"
        );
    }
}

#[test]
fn tail_calls_are_transparent_to_the_activation_closure() {
    // A true tail call replaces its caller activation. The tail caller must
    // still be traversed so an older ordinary caller is found, but the
    // eliminated frame itself must not be serialized.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $tail_indirect_target)
          (func $tail_direct (export "tail_direct") (result i32)
            return_call $fork)
          (func $above_tail_direct (export "above_tail_direct") (result i32)
            call $tail_direct)
          (func $tail_indirect_target (export "tail_indirect_target") (result i32)
            call $fork)
          (func $calls_tail_indirect (export "calls_tail_indirect") (result i32)
            i32.const 0
            return_call_indirect (type $ft))
          (func $above_tail_indirect (export "above_tail_indirect") (result i32)
            call $calls_tail_indirect))
    "#;
    let found = discover_semantic_activations(wat);
    for name in [
        "above_tail_direct",
        "tail_indirect_target",
        "above_tail_indirect",
    ] {
        assert!(found.iter().any(|n| n == name), "missing {name}: {found:?}");
    }
    for name in ["tail_direct", "calls_tail_indirect"] {
        assert!(
            !found.iter().any(|n| n == name),
            "tail-eliminated activation {name} must not be serialized: {found:?}"
        );
    }
}

#[test]
fn suspension_capable_tail_sites_are_reported_without_becoming_activations() {
    // The activation graph stays semantically truthful. Exact tail sites
    // remain useful diagnostics, but replay no longer lowers them into frames.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $fork_target)
          (elem declare func $fork_target)
          (func $fork_target (result i32)
            call $fork)
          (func $tail_direct (export "tail_direct") (result i32)
            return_call $fork)
          (func $tail_indirect (export "tail_indirect") (result i32)
            i32.const 0
            return_call_indirect (type $ft))
          (func $tail_ref (export "tail_ref") (result i32)
            ref.func $fork_target
            return_call_ref $ft))
    "#;
    let found = discover_tail_landings(wat);
    for expected in [
        ("tail_direct".to_string(), TailCallKind::Direct),
        ("tail_indirect".to_string(), TailCallKind::Indirect),
        ("tail_ref".to_string(), TailCallKind::Ref),
    ] {
        assert!(
            found.contains(&expected),
            "missing tail landing {expected:?}: {found:?}"
        );
    }
}

#[test]
fn public_analysis_does_not_report_eliminated_tail_callers() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $tail_direct (export "tail_direct") (result i32)
            return_call $fork))
    "#;
    let found = discover(wat);
    assert!(
        !found.contains("tail_direct"),
        "the public transform analysis must not invent an activation for a \
         suspension-capable tail edge: {found:?}"
    );
}

#[test]
fn semantic_control_closure_retains_tail_nodes_without_materializing_frames() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $fork_target)
          (elem declare func $fork_target)
          (func $fork_target (result i32)
            call $fork)
          (func $ordinary_target (result i32)
            i32.const 9)
          (func $ordinary_tail (export "ordinary_tail") (result i32)
            return_call $ordinary_target)
          (func $tail_direct (export "tail_direct") (result i32)
            return_call $fork)
          (func $tail_indirect (export "tail_indirect") (result i32)
            i32.const 0
            return_call_indirect (type $ft))
          (func $tail_ref (export "tail_ref") (result i32)
            ref.func $fork_target
            return_call_ref $ft))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let module = walrus::Module::from_buffer(&bytes).expect("walrus parse");
    let seed =
        call_graph::find_import_func(&module, "kernel.kernel_fork").expect("fork seed import");
    let after = call_graph::analyze_reaching_closure(&module, seed);
    assert!(
        after.tail_call_landings.len() == 3,
        "all fork-reaching tail sites remain semantic tail edges: {:?}",
        after.tail_call_landings
    );
    let activation_names: HashSet<_> = after
        .activations
        .iter()
        .map(|&id| call_graph::func_display_name(&module, id))
        .collect();
    for name in ["tail_direct", "tail_indirect", "tail_ref"] {
        assert!(
            !activation_names.contains(name),
            "tail traversal must not materialize {name} as a real activation: \
             {activation_names:?}"
        );
        let function = module
            .funcs
            .iter()
            .find(|function| function.name.as_deref() == Some(name))
            .expect("named tail function");
        assert!(
            after.control_reachable.contains(&function.id()),
            "{name} must remain in the semantic call-target closure"
        );
    }
    assert!(!activation_names.contains("ordinary_tail"));
}

#[test]
fn indirect_closure_reaches_a_fixed_point_beyond_two_hops() {
    // Models a three-dispatch trampoline chain:
    //
    //   $hop1 call_indirect -> $fork_target       (depth 1)
    //   $hop2 call_indirect -> $hop1              (depth 2)
    //   $third_hop call_indirect -> $hop2         (depth 3)
    //
    // Every edge is a real possible fork path. A package-specific depth cap
    // would miss the third activation and corrupt replay.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $fork_ty (func (result i32)))
          (type $hop1_ty (func (result i64)))
          (type $hop2_ty (func (result f32)))
          (table 4 funcref)
          (elem (i32.const 0) $fork_target $hop1 $hop2 $safe_hop2_target)

          (func $fork_target (export "fork_target") (result i32)
            call $fork)

          (func $hop1 (export "hop1") (result i64)
            i32.const 0
            call_indirect (type $fork_ty)
            drop
            i64.const 1)

          (func $hop2 (export "hop2") (result f32)
            i32.const 1
            call_indirect (type $hop1_ty)
            drop
            f32.const 1)

          (func $safe_hop2_target (result f32)
            f32.const 0)

          (func $third_hop (export "third_hop") (param i32) (result f32)
            local.get 0
            call_indirect (type $hop2_ty)))
    "#;
    let found = discover(wat);
    for name in ["fork_target", "hop1", "hop2", "third_hop"] {
        assert!(found.iter().any(|n| n == name), "missing {name}: {found:?}");
    }
    assert!(
        !found.iter().any(|n| n == "safe_hop2_target"),
        "safe table target should not be pulled into the fork path; got {found:?}"
    );
}
