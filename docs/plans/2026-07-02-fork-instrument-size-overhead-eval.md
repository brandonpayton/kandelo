# Fork-Instrumentation Size Overhead — Evaluation & Recommendation

- Bead: kd-ok55 (discovered from kd-lfas)
- Date: 2026-07-02
- Author: designer-adhoc-f8a9bbfb5b (Kandelo feature designer)
- Status: **Design/evaluation only — no emitter changes proposed for immediate landing.**
- Subject crate: `crates/fork-instrument/` (kernel tooling; distinct from package recipes)

## TL;DR and recommendation

`wasm-fork-instrument` roughly **doubles the code section** of every fork-using
language runtime: measured code-section growth is **+127% for perl** and
**+167% for ruby** (clean single-step). On a whole-shipped-binary basis that is
perl +72% over raw / ~42% of the shipped bytes. The cost is **real, large, and
general** across every fork-instrumented runtime — not a perl quirk.

The dominant driver is **not** inefficient stubs. The primary, **measured**
driver is that the fork-path reverse-reachability closure captures **69–87% of
all functions** in these programs (measured across bash, coreutils, vim, git,
ruby, php, php-fpm). The *secondary* driver — the per-function cost, ~1,290 B on
an unoptimized ruby build — is, by a byte-level read of the emitter, dominated by
**per-scalar-local save/restore**, a term that is a hard inline floor under
WebAssembly's static-local-index rule. That per-function apportionment is
**analytically derived, not yet measured** (see the honesty note in
[Cost model](#cost-model-triangulated-for-a-and-b-analytical-for-c)); settling it
is exactly what the `--stats` enabler below unblocks.

**Recommendation: DEFER** a dedicated size-reduction project, with two riders:

1. **DO now (cheap, safe, high-leverage enabler):** add a `--stats` mode to
   `wasm-fork-instrument` reporting functions instrumented / total, call sites,
   spilled locals, and bytes added per section. It requires **no emitter change
   and no ABI impact**, and every future size decision needs it (today the
   numbers must be reverse-engineered with `wasm-objdump`). Tracked here as a
   small follow-up.
2. **If/when the size work is prioritized**, pursue it in this risk-ordered
   sequence, and **not** the order implied by the bead title:
   1. **Frame-pointer CSE** (cache `*(buf+0)` in a local) — ABI-neutral,
      ~15–20% code reduction, lowest risk.
   2. **Fork-live-only local spill** (liveness-prune the dominant term) —
      larger win, medium-high risk.
   3. **Tighter fork-path selection** (better `call_indirect` index
      resolution / scoped dynamic-table-write unknownness) — the biggest
      potential win but the highest correctness risk.

**Explicit won't-fix-for-size:** reviving the scaffolded "runtime-dispatcher
trampoline" (table-driven dispatch) **to reduce size**. It targets the inline
dispatch-block term, which measurement shows is a *minor* fraction of the
overhead, while adding a REWIND-path `call_indirect` and per-function tables.
(It may still be worth finishing for the separate dispatch-*depth* limit tracked
in `2026-06-05-fork-instrument-recursive-bucketing-plan.md`; that is not a size
argument.)

Every lever above touches a **correctness-critical, fuzz-gated emitter**: any
change must re-clear the ≥10,000-iteration fork fuzz gate plus the POSIX/libc
suites, because a subtle rewind defect corrupts forked child processes
*silently*. That validation cost — not implementation difficulty — is the main
reason to defer.

## Problem statement

kd-lfas established that the dominant size factor in fork-instrumented runtimes
is the fork instrumentation itself, not `--no-gc-sections` dead code: perl
5.40.3 raw `make -k` output is 4,232,959 B; after `wasm-fork-instrument` it is
7,291,919 B (+3,058,960 B, ~42% of the shipped binary, +72% over raw), while a
`wasm-opt -O2` DCE pass reclaims only ~446 KB. Because instrumentation must run
*after* `wasm-opt` (it hardcodes mutable-global offsets), `wasm-opt` cannot
touch the instrumentation stubs.

This applies to **all** fork-instrumented packages (bash, dash, git, php,
php-fpm, vim, tcl, coreutils, nginx, dinit, ruby, lsof, netcat, perl, …), so a
proportional win compounds across the registry.

kd-ok55 asks: **can the save/restore stubs be made smaller** (shared helper vs
per-function inlined stubs, table-driven unwind, only instrumenting functions
actually on a fork path), is it feasible, and is it worth it — do / defer /
won't-fix.

## Non-goals

- Not implementing any emitter change. This bead's acceptance is measurement +
  assessment + recommendation. Per project guidance, implementation is out of
  scope unless a bead explicitly asks for it.
- Not changing the fork ABI, save-buffer layout, or the `wpk_fork_*` export
  contract.
- Not reviving Asyncify. `wasm-fork-instrument` is the active path.
- Not re-litigating correctness of the current tool. It is assumed correct and
  fuzz-gated; this document only evaluates its size.
- Not a package-recipe change. The subject is `crates/fork-instrument/`.

## Background: what the tool emits, and why

`wasm-fork-instrument` gives WebAssembly POSIX `fork()` by rewriting every
function that can transitively reach the `kernel.kernel_fork` import so the host
can unwind the wasm call stack into linear memory, clone the instance, copy
memory, and rewind the child to the exact `fork()` call site. WebAssembly hides
its call stack from the embedder, so this **must** be compile-time per-function
machinery (`docs/fork-instrumentation.md`; `docs/plans/2026-04-20-fork-instrumentation-design.md`).

Each instrumented function is rewritten to
`[state-test preamble] [ $unwind_save block { dispatch; wrapped calls } ] [postamble]`
(`crates/fork-instrument/src/instrument.rs:613`). All of it is emitted
**inline**; the five exported `wpk_fork_*` runtime functions are driven by the
host, never called from instrumented bodies. Concretely, per function:

- **Preamble** — on `REWINDING`, rewind the frame cursor, reload the frame, and
  deserialize each scalar local from the save buffer (`instrument.rs:2866`).
- **Dispatch** — a `br_table` keyed on `frame.call_index`, gated by
  `state == REWINDING`, jumps straight to the matching `$POST_K` landing so the
  pre-call body never re-executes on rewind (`instrument.rs:2114`). Bucketed at
  the top level (`BUCKET_SIZE = 32`); flat per region when nested.
- **Per call site** — the original call is preserved; an UNWIND bridge writes
  `frame.call_index` and branches to `$unwind_save` (`instrument.rs:2802`).
  Non-pure call arguments are spilled to synthetic locals and reloaded; pure
  scalar tails are replayed instead of spilled (`instrument.rs:1771`).
- **Postamble** — write the frame header (func index, zeroed catch header),
  serialize each scalar local to the buffer, bump the frame cursor, return a
  default value (`instrument.rs:2949`).
- **Ref-typed locals** (funcref/externref/exnref) spill to per-module aux tables
  sized exactly to the assigned slot count (`instrument.rs:3543`).

Selection is a reverse-reachability closure from `kernel_fork`
(`crates/fork-instrument/src/call_graph.rs:589`): direct callers are added
transitively and exactly; indirect callers are added when a `call_indirect`
can dispatch to a fork-reachable target of matching signature in the same table,
**bounded to two dispatch hops** to avoid closing over an entire interpreter
from one generic dispatcher.

## Measurement

Tool built from the convoy base (`scripts/build-fork-instrument-tool.sh`).
Fork-path counts via `wasm-fork-instrument … --discover-only` (JSON `count`
includes the seed import ⇒ instrumented `F = count − 1`). Section/function
counts via `wasm-objdump -h`. Shipped binaries read read-only from the primary
checkout (`primary_checkout_exception=read-only` recorded on the bead). Raw data
under `test-runs/kd-ok55/` (`real-selection.tsv`, `real-runtime-findings.md`,
`measurements.tsv`, `table.txt`, `section-dumps.txt`).

### Selection ratio — fraction of all functions instrumented (shipped binaries)

| runtime | defined funcs | instrumented F | **F / defined** |
|---|--:|--:|--:|
| bash | 1,800 | 1,445 | **80.3%** |
| coreutils | 3,351 | 2,313 | **69.0%** |
| vim | 4,423 | 3,489 | **78.9%** |
| git | 5,071 | 4,417 | **87.1%** |
| ruby | 7,183 | 6,238 | **86.8%** |
| php | 23,475 | 18,228 | **77.6%** |
| php-fpm | 23,699 | 18,401 | **77.6%** |

The fork-path closure engulfs **69–87% of every program**. (Footnote: these are
already-instrumented shipped binaries, so the `defined` denominator includes the
5 `wpk_fork_*` runtime functions; against the true original count the ratios are
marginally *higher* — e.g. bash 1445/1795 = 80.5% — so the table is slightly
conservative. `--discover-only` is idempotent on instrumented binaries because
the original calls are preserved, so it recovers the same fork-path set.) This is
far above the original design's "well-scoped onlylist ⇒ +2–5% total module size"
expectation (`2026-04-20-fork-instrumentation-design.md` §7.2). In tightly
connected runtimes, `fork()`/`system()`/`popen()`/`posix_spawn()` sits near the
bottom of a dense call graph, so reverse reachability naturally captures most of
it; the conservative indirect closure (below) inflates it further.

### Clean code-section delta on a real interpreter (ruby)

Total-file deltas on real binaries are **confounded** because the tool drops
custom (debug/name) sections on rewrite — the raw no-cflags ruby carries ~12.6 MB
of debug info (raw 22.4 MB vs stripped `roots` 9.83 MB, identical 9,299
functions). The confound-free metric is the **code section**, measured on a
single clean instrument step of the stripped build:

| | code section | data section | funcs |
|---|--:|--:|--:|
| ruby (pre-instrument) | 5,946,789 B | 3,671,022 B | 9,299 |
| ruby (instrumented) | 15,858,681 B | 3,671,022 B (unchanged) | 9,304 (+5 `wpk_*`) |
| **delta** | **+9,911,892 B (+166.7%)** | 0 | — |

Instrumented `F = 7,681` ⇒ **~1,290 B per instrumented function**. Overhead is
~100% code (data untouched), matching the synthetic finding that >98% of growth
is the Code section. (This is a no-cflags/unoptimized build, so 1,290 B/function
is an upper bound; the shipped optimized perl figure of +42% is the
representative optimized-runtime number.)

Reference (kd-lfas, shipped optimized perl): raw 4,232,959 B → 7,291,919 B;
instrumented code section 5,477,124 B ⇒ raw code ~2.42 MB, **+127% code growth**.

### Cost model (triangulated for A and B; analytical for C)

Analytical (byte-level read of the emitter), synthetic scaling runs, and the
real-ruby total agree on the model *shape* and pin the fixed and per-call terms:

```
bytes(f) ≈ A + B·(fork_call_sites) + C·(scalar_locals) + C_ref·(ref_locals) + Sarg
```

| term | value | note |
|---|--:|---|
| **A** fixed boilerplate | ~110 B/function | preamble+dispatch+postamble frame writes; ~9% of real per-fn cost |
| **B** per fork call site | ~26–27 B | POST block + UNWIND bridge + br_table slot |
| **C** per scalar local | ~20 B | **dominant term for real local-heavy C functions** |
| **C_ref** per ref local | ~12 B + 1 table slot | |
| **Sarg** non-pure call args | ~24·m per such call | 0 when the arg tail is a pure scalar replay |
| module floor | ~483 B once | 5 `wpk_fork_*` funcs + 2 globals + exports |

**What is measured vs. inferred (honesty note).** `A` and `B` are measured: the
synthetic `manyfn` scaling pins the marginal cost of a 1-fork-call, 0-local
function at 110.0 B, and the `dispatcher` scaling pins ~27 B/call-site. But
**both synthetic generators emit functions with no locals**, so the `C` term
(≈20 B/scalar-local) and `Sarg` are **not** validated by measurement — they come
from the byte-level read of the emitter alone. The real-ruby total (1,290 B/fn)
confirms the *sum* is large but does **not** decompose the ~1,180 B residual
among `C·L`, `B·K`, and `Sarg`. So treat "`C·L` is the largest per-function
term" as a well-reasoned hypothesis, not a measured fact. (Minor: because the
measured `A`≈110 already includes one call site's `B`, the pure fixed term is
~83 B; the terms are loosely pinned.)

**Apportionment (build-dependent).** On the unoptimized no-cflags ruby
(~1,290 B/fn) the fixed boilerplate `A` is ~9%. On the *optimized* builds the
recommendation actually cares about (smaller per-function totals, fewer locals),
`A` is a **larger** share — plausibly ~15–20% — and the `C·L` dominance
correspondingly **weakens**. The 1,290 B/fn figure is from the no-cflags build in
sibling worktree `kd-drt.9` (read-only) and is not reproducible from this
worktree; it is an upper bound, not the representative case. A further caveat on
"not the dispatch shape": every `call_indirect` in an instrumented function is
wrapped **unconditionally** (`instrument.rs:1705`), so in indirect-heavy
interpreters the `B·K` term is larger than in ordinary C — which is also why
lever D (below) is worth doing. Net: the multiplier that is **measured** to
matter is **`F`** (69–87% of the program); **`L`** matters per the model but its
weight is unmeasured. `Σ_f (A + 20·L_f + 27·K_f)` is the right shape; the
coefficients on `L` await `--stats`.

## Levers evaluated

### The bead's three candidates

**1. "Only instrument functions actually on a fork path" — ALREADY DONE; now
near its floor.** Selection is already a reverse-reachability closure, not
whole-module. The measurement shows the honest consequence: on real runtimes
that closure is 69–87% of the program. The remaining question is whether the set
is *over-approximated*. It partly is — see selection-tightening below — but the
easy version of this lever is exhausted.

**2. "Shared helper vs per-function inlined stubs" — mostly INFEASIBLE; bounded
by wasm.** Two hard WebAssembly constraints cap it:
   - **Static local indexing.** `local.get`/`local.set` take an immediate
     index; a shared helper cannot read or write another frame's locals. The
     per-local spill/reload (the *dominant* `C·L` term) therefore **must** stay
     inline. Passing locals as helper arguments still emits one `local.get` per
     local at the call site plus call overhead — no win.
   - **Structured control flow.** `br_table` can only target enclosing labels;
     the dispatch skeleton cannot live in a callee. It must stay inline.

   Only the **fixed frame-header writes** (cursor math, func-index/catch-header
   stores, cursor bump) are memory-only and shareable into a helper — but that
   is the ~9% `A` term. A shared boilerplate helper is therefore **low value**.
   *(A related but distinct intra-function optimization — frame-pointer CSE — is
   the real safe win; see below. It is not a "shared helper.")*

**3. "Table-driven unwind" — feasible and half-built, but WON'T-FIX FOR SIZE.**
The "runtime-dispatcher trampoline" (extract post-call chunks into a per-function
funcref table, `call_indirect` on REWIND) was explicitly proposed as a code-size
lever and **scaffolded in-tree** (`instrument.rs` `emit_per_function_post_table`,
`extract_chunk_to_function`, `instrument_one_function_trampoline_dispatch` — the
last is a `panic!`/`unimplemented!` placeholder; `tests/trampoline.rs`). It was
set aside not on merit but because extending the inline switch-dispatch was a
smaller implementation diff (~80–120 LoC vs ~300–500). **However**, it targets
the inline **dispatch/POST_K** term, which the cost model shows is a *minor*
fraction of per-function cost (the `B·K` term, ~2–5% of a real function), while
it *adds* a REWIND-path `call_indirect` (perf) and per-function funcref tables
(size). As a **size** play it is net-marginal at best. Recommend won't-fix for
size; finish it only if the separate dispatch-depth limit
(`2026-06-05-…-recursive-bucketing-plan.md`) requires it.

### Additional levers derived from the measurement (higher value)

**A. Frame-pointer CSE — the best risk-adjusted win. LOW risk, ABI-neutral.**
`*(buf+0)` (the current frame base, `global.get $buf; i32.load 0`, ~5 B) is
recomputed at **every** local save, local restore, call-index store, cursor
bump, and dispatch. Computing it once into a synthetic local per region and
reusing it removes ~3 B at each of the ~`(2L + K + 3)` sites per function.
Estimated **~15–20% total code reduction**. It is pure intra-function common-
subexpression elimination: **no frame-layout change, no ABI change, no
`ABI_VERSION` bump** (structural snapshot may shift and must be regenerated).
This is the one change small and safe enough to consider landing on its own.
Two caveats: (i) the cached frame-base local must be **excluded from the
scalar-local spill set**, or the emitter will save/restore it like a user local —
growing `frame_size` (breaking ABI-neutrality) and cancelling the win; (ii) this
lever's payoff and the `C·L` dominance above are **coupled** — both scale with
`L`, so both are settled by the same `--stats` local histogram. If `L` turns out
modest, expect the low end (~15%) and a smaller `C·L` share.

**B. Fork-live-only local spill — the biggest *safe-ish* structural win.**
Today every scalar local is spilled/reloaded. Only locals **live across the
fork call** need saving. A standard liveness pass that spills the live-across-
fork subset would cut the dominant `C·L` term substantially (interpreter
functions have many locals but few live at any one fork call site). Medium-high
risk: missing a live local silently corrupts the child. Well-understood analysis,
but must be conservative (spill on any doubt) and fuzz-gated.

**C. Tighter fork-path selection — biggest potential, highest risk.** The
indirect closure is conservative: an unresolved/dynamic `call_indirect` index
pulls in *all same-signature functions in the table*, and a single dynamic table
write (`table.set/fill/grow`) makes the whole table match module-wide
(`call_graph.rs:328`,`:458`). Extending `IndexProof` (`call_graph.rs:211`) to
recover LLVM jump-table / GOT-constant function pointers, and scoping table-write
unknownness to resolvable `ref.func` writes, would shrink `F` toward the truly-
reachable set. This is a **may-analysis for correctness**: a missed real target
is an un-instrumented fork site → silent state corruption. Any unresolved index
must still fall back to the conservative set. High value, high risk.

**D. Don't wrap non-fork `call_indirect` sites — safe, modest.** Once a function
is in the set, **every** `call_indirect` in it is wrapped as a fork landing with
no reachability check, unlike direct calls which are gated on the target being
fork-reachable (`instrument.rs:1705` vs `:1696`). Gating indirect wrapping on the
same `table_can_dispatch + types_match + target∈fork_path` predicate the closure
already trusts removes dispatch/spill code at indirect sites that provably cannot
reach fork — **no less sound than current selection**. Modest but among the
safest structural wins.

**E. Skip the zeroed 8-byte catch header for no-catch functions — safe, minor.**
Functions with no fork-path `try_table` still write an 8-byte zero catch header
and reserve the header slot (`instrument.rs:2992`). A no-catch variant drops
~10 code B/function and shrinks the frame. Low risk; requires a frame-layout
variant (snapshot regen).

## Is it worth it?

- **The overhead is material.** For php (37 MB) and ruby (17 MB), even a 20% code
  cut is multiple MB off download/parse/instantiate — most impactful on the
  browser host. Not negligible.
- **But the binaries are correct and already better than the alternative.** The
  design intends (and the retired full-module fork-continuation carve-out
  confirms) that this tool is equal-or-smaller than what preceded it
  (`docs/fork-instrumentation.md` §Performance envelope). Instrumentation size is
  the price of POSIX fork on wasm, not a regression.
- **No lever is a free win.** Every emitter change must re-pass the ≥10,000-iter
  fork fuzz gate, `scripts/run-posix-tests.sh`, `scripts/run-libc-tests.sh`,
  `cargo test -p fork-instrument`, and re-verify fork-heavy demos on both hosts.
  A rewind defect fails *silently in children*, the worst failure class.

This is a genuine prioritization call for @brandon: real multi-MB wins are
available but gated behind correctness-critical work on a load-bearing tool.
Hence **defer**, with the safe CSE win and the `--stats` enabler broken out.

## Recommended sequence (if prioritized)

1. **`--stats` mode** (DO now; no emitter change). Report F/total, call sites,
   spilled scalar/ref locals (a histogram of `L` and `K` per function), and
   per-section byte deltas. This is a **prerequisite, not a nicety**: the
   per-function apportionment — especially the `C·L` local term the whole
   "defer + later liveness-prune" thesis rests on — is currently *unmeasured*,
   so the size case cannot be fully adjudicated until these histograms exist. It
   also gives every later step a regression signal.
2. **Frame-pointer CSE** (lever A). ABI-neutral, ~15–20%, lowest risk. Land
   behind the full gate; regenerate `abi/snapshot.json` (structural only).
3. **Don't-wrap-non-fork-indirect-sites** (lever D) + **no-catch-header skip**
   (lever E). Safe, additive.
4. **Fork-live-only local spill** (lever B). The big structural win; stage behind
   its own fuzz campaign.
5. **Selection tightening** (lever C). Only with a dedicated correctness budget
   and expanded fuzz coverage for indirect/dynamic-table shapes.

Do **not** start with the trampoline; it is the smallest size component.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Silent child corruption from a rewind bug | Every step behind the ≥10k-iter fuzz gate + POSIX/libc suites + fork-heavy demo verification on Node and browser. Default-conservative in every analysis. |
| Selection tightening drops a real fork path | Keep the conservative fallback for any unresolved index/dynamic table; add indirect/dynamic-table fuzz fixtures before shrinking. |
| Liveness pruning misses a live local | Spill on any uncertainty; validate against the full save/restore round-trip fuzzer. |
| ABI/snapshot drift | CSE and dispatch-topology changes keep the frame/buffer ABI byte-identical ⇒ no `ABI_VERSION` bump, but regenerate and verify `abi/snapshot.json` (additive). Catch-header/frame-layout variants that change bytes require the graded ABI policy in `docs/abi-versioning.md`. |
| Instrumentation is not byte-reproducible across runs | Pre-existing for all fork-instrumented packages; unrelated to these levers but note it when comparing bottle shas. |
| Effort spent for a modest, risky win | The `--stats` + CSE steps are cheap and safe; gate the expensive levers (B, C) on measured demand. |

## Test and documentation plan (for any future implementation)

- **Emitter:** `cargo test -p fork-instrument --target "$HOST_TARGET"`;
  `scripts/run-fork-instrument-fuzz.sh` at ≥10,000 iterations, zero validator
  failures; add fixtures for any newly optimized shape (per the fuzz-to-fixture
  rule in the crate README).
- **Kernel/host:** `cargo test -p kandelo --target aarch64-apple-darwin --lib`;
  `cd host && npx vitest run`; `scripts/run-posix-tests.sh`;
  `scripts/run-libc-tests.sh`; `bash scripts/check-abi-version.sh`.
- **Runtimes:** re-instrument bash/git/php/ruby/perl; confirm `--discover-only`
  counts and byte deltas via `--stats`; run fork-heavy demos
  (`wordpress`, `erlang-ring`, `process-lifecycle`) on Node and browser
  (`./run.sh browser`).
- **Docs:** update `docs/fork-instrumentation.md` (dispatch/spill sections),
  `crates/fork-instrument/README.md`, and `abi/snapshot.json` if the structural
  snapshot shifts; note any `ABI_VERSION` change per `docs/abi-versioning.md`.

## Open questions

- What fraction of the 69–87% closure is *spurious* (indirect over-approximation)
  vs genuinely fork-reachable? Answering needs a "direct-only vs full-closure"
  count — a small addition to `--discover-only`/`--stats`. This decides whether
  lever C is transformative or marginal.
- Average locals-live-across-fork vs total locals per fork-path function — sets
  the ceiling on lever B. Also a `--stats` output.
- Does the browser host's parse/instantiate budget make even a 15–20% cut
  worth the emitter risk on its own, independent of the larger levers?
- Should `--stats` land as its own tiny PR immediately (it is safe and unblocks
  every measurement)?

## Appendix: reproduction

```sh
# Build the host-side tool
scripts/build-fork-instrument-tool.sh   # -> tools/bin/wasm-fork-instrument
#   (host env note: if cc can't find clang under a Nix SDK, prefix with
#    DEVELOPER_DIR=/Library/Developer/CommandLineTools)

# Selection ratio for any built runtime
F=$(tools/bin/wasm-fork-instrument <runtime>.wasm --discover-only | jq .count)
echo "instrumented = $((F-1))"
wasm-objdump -h <runtime>.wasm | awk '/^ Function /{print "defined =",$NF}'

# Clean code-section delta (use a stripped/no-debug input to avoid the
# tool's custom-section drop confounding the total-file size)
tools/bin/wasm-fork-instrument <stripped>.wasm -o /tmp/out.wasm
wasm-objdump -h <stripped>.wasm | grep -E '^ +Code '   # before
wasm-objdump -h /tmp/out.wasm   | grep -E '^ +Code '   # after
```
