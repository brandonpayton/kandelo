# Real-runtime fork-instrumentation measurements (kd-ok55)

Tool: tools/bin/wasm-fork-instrument (built from convoy base, aarch64-apple-darwin).
Method: `--discover-only` for fork-path count; `wasm-objdump -h` for section/function counts.
Inputs: shipped instrumented binaries in /Users/brandon/src/kandelo/packages/registry/*/bin/
(read-only, primary_checkout_exception=read-only recorded on bead); ruby raw/stripped from
sibling worktree kd-drt.9 (read-only).

## Selection ratio (fraction of ALL functions instrumented) — shipped binaries
| runtime | defined funcs | instrumented F | F/defined |
|---|--:|--:|--:|
| bash       | 1800  | 1445  | 80.3% |
| coreutils  | 3351  | 2313  | 69.0% |
| vim        | 4423  | 3489  | 78.9% |
| git        | 5071  | 4417  | 87.1% |
| ruby       | 7183  | 6238  | 86.8% |
| php        | 23475 | 18228 | 77.6% |
| php-fpm    | 23699 | 18401 | 77.6% |

=> The fork-path reverse-reachability closure captures ~69-87% of every program.
   This, not per-function stub inefficiency, is the primary size driver.

## Clean single-step CODE-section delta on real interpreter (ruby, stripped `roots` build)
raw code       = 5,946,789 B   (data 3,671,022 B, 9299 funcs)
instrumented   = 15,858,681 B  (data 3,671,022 B unchanged, 9304 funcs, 5 wpk exports)
CODE delta     = +9,911,892 B  = +166.7% of raw code
instrumented F = 7,681  =>  ~1,290 B per instrumented function (no-cflags build; upper bound)
Data unchanged => overhead is ~100% code.

## Reference (kd-lfas, shipped optimized perl)
raw 4,232,959 B -> instrumented 7,291,919 B  (+3,058,960 B, +72% of raw, 42% of shipped)
instrumented code section = 5,477,124 B (=> raw code ~2.42 MB, +127% code growth).

## Cost model (triangulated: analytical + synthetic + real ruby)
bytes(f) ~= A + B*callsites + C*scalar_locals + C_ref*ref_locals + Sarg
  A ~= 110 B (fixed preamble/postamble/dispatch boilerplate) -- ~9% of real per-fn cost
  B ~= 26-27 B per fork-path call site
  C ~= 20 B per scalar local  <-- DOMINANT term for real local-heavy C functions
Module floor ~= 483 B (5 wpk_fork_* funcs + 2 globals + exports).
